import { coreSettingsRegistry, type Core, type CoreSettingKey, type PlayerView } from '@nextskin/domain'
import { describe, expect, it, test, vi } from 'vitest'
import { createApp } from './app.ts'
import { createTranslator } from '@nextskin/i18n'

const player: PlayerView = {
  pid: 1,
  name: 'Alice',
  uuid: 'a'.repeat(32),
  updatedAt: '2026-01-02T03:04:05.000Z',
  ownerBanned: false,
  skin: null,
  cape: null,
}

function mockCore(stored: Partial<Record<CoreSettingKey, unknown>> = {}) {
  const read = vi.fn((keys: readonly CoreSettingKey[]) => {
    const values: Record<string, unknown> = {}
    for (const key of keys) {
      const definition = coreSettingsRegistry[key]
      const parsed = definition.schema.safeParse(key in stored ? stored[key] : definition.default)
      if (!parsed.success) throw new Error(`设置项 ${key} 读取失败`)
      values[key] = parsed.data
    }
    return Promise.resolve(values)
  })
  const findByName = vi.fn().mockResolvedValue(player)
  const findByUuid = vi.fn().mockResolvedValue(player)
  const getSessionUser = vi.fn<Core['auth']['getSessionUser']>().mockResolvedValue(null)
  const getSigningKey = vi.fn<Core['yggdrasil']['getSigningKey']>().mockResolvedValue(null)
  const handle = vi.fn((request: Request, root: string) => Promise.resolve(Response.json({ url: request.url, root })))
  const core = {
    settings: { read },
    players: { findByName, findByUuid },
    yggdrasil: { getSigningKey },
    auth: {
      getSessionUser,
      openIdConfigurationUrl: vi.fn().mockResolvedValue(null),
      handle,
    },
  } as unknown as Core
  return { core, read, findByName, findByUuid, getSessionUser, getSigningKey, handle }
}

describe('createApp', () => {
  it('健康端点应用默认缓存和 ALI；维护开关与 ALI 一起读取', async () => {
    const { core, read } = mockCore()
    const res = await createApp({ core }).request('http://example.test/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(read.mock.calls).toEqual([
      [['yggdrasil.apiLocationIndication', 'maintenance.enabled', 'maintenance.blockProtocols']],
    ])
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('cache-control')).toBe('no-cache, private')
    expect(res.headers.get('x-authlib-injector-api-location')).toBe('http://example.test/api/yggdrasil')
  })

  it('/api/auth/* 原样交给领域层，并带上客户端看到的站点地址', async () => {
    const { core } = mockCore()
    const res = await createApp({ core }).request('http://127.0.0.1:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { host: 'skin.example.test', 'x-forwarded-proto': 'https' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      url: 'http://127.0.0.1:3000/api/auth/sign-in/email',
      root: 'https://skin.example.test',
    })
    expect((core.auth.handle as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('坏的 skinDomains 只影响元数据端点，CSL 照常 200', async () => {
    const { core, read } = mockCore({ 'yggdrasil.skinDomains': [1] })
    const app = createApp({ core })
    const csl = await app.request('http://example.test/Alice.json')
    expect(csl.status).toBe(200)
    expect(await csl.json()).toEqual({ username: 'Alice', skins: { default: null }, cape: null })
    expect(read.mock.calls).toEqual([
      [['yggdrasil.apiLocationIndication', 'maintenance.enabled', 'maintenance.blockProtocols']],
      [['cache.publicMaxAge']],
    ])
    const metadata = await app.request('http://example.test/api/yggdrasil')
    expect(metadata.status).toBe(500)
    expect(await metadata.text()).toBe('Internal Server Error')
    expect(metadata.headers.get('cache-control')).toBe('no-cache, private')
    expect(metadata.headers.get('x-authlib-injector-api-location')).toBe('http://example.test/api/yggdrasil')
  })

  it('超限时返回 ForbiddenOperationException 并说明上限，不带 ALI，也不执行角色查询', async () => {
    const { core, findByName } = mockCore({ 'yggdrasil.profileSearchLimit': 3 })
    const response = await createApp({ core }).request('http://example.test/api/yggdrasil/api/profiles/minecraft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2,3,4]',
    })
    expect(response.status).toBe(403)
    const body: unknown = await response.json()
    expect(body).toEqual({
      error: 'ForbiddenOperationException',
      errorMessage: createTranslator('zh-CN')('yggdrasil.errors.query_limit', { count: 3 }),
    })
    expect(response.headers.has('x-authlib-injector-api-location')).toBe(false)
    expect(findByName).not.toHaveBeenCalled()
  })

  it('ALI 开关为 false 时不添加响应头', async () => {
    const { core } = mockCore({ 'yggdrasil.apiLocationIndication': false })
    const response = await createApp({ core }).request('http://example.test/api/health')
    expect(response.headers.has('x-authlib-injector-api-location')).toBe(false)
  })
})

describe('路由边界', () => {
  it('末尾带斜杠的路径与不带斜杠的相同', async () => {
    const { core } = mockCore()
    const res = await createApp({ core }).request('http://example.test/api/health/')
    expect(res.status).toBe(200)
  })

  test.each([
    '/api/yggdrasil/sessionserver/session/minecraft/profile/abc%2F',
    '/api/yggdrasil/api/users/profiles/minecraft/Alice%2F',
    '/csl/Dot.Name.json',
    '/csl/Alice%2F.json',
    '/not-a-protocol',
  ])('不匹配的路由 %s 不返回 405，也不查询角色', async (path) => {
    const { core, findByName, findByUuid } = mockCore()
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const response = await createApp({ core }).request(`http://example.test${path}`, { method })
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-cache, private')
      expect(response.headers.has('allow')).toBe(false)
    }
    expect(findByName).not.toHaveBeenCalled()
    expect(findByUuid).not.toHaveBeenCalled()
  })

  it('405 带 ALI，且只读全局设置，不触发角色查询或端点设置', async () => {
    const { core, read, findByName } = mockCore()
    const response = await createApp({ core }).request('http://example.test/csl/Alice.json', { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(response.headers.get('x-authlib-injector-api-location')).toBe('http://example.test/api/yggdrasil')
    expect(read.mock.calls).toEqual([
      [['yggdrasil.apiLocationIndication', 'maintenance.enabled', 'maintenance.blockProtocols']],
    ])
    expect(findByName).not.toHaveBeenCalled()
  })
})

describe('手动维护', () => {
  test('匿名 REST 请求返回本地化 site_maintenance，缓存和 ALI 正常，不带 Retry-After', async () => {
    const { core, read, getSessionUser } = mockCore({ 'maintenance.enabled': true })
    const response = await createApp({ core }).request('http://example.test/api/openapi.json', {
      headers: { 'accept-language': 'en' },
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'site_maintenance', message: createTranslator('en')('errors.site_maintenance') },
    })
    expect(response.headers.get('cache-control')).toBe('no-cache, private')
    expect(response.headers.get('x-authlib-injector-api-location')).toBe('http://example.test/api/yggdrasil')
    expect(response.headers.has('retry-after')).toBe(false)
    expect(getSessionUser).not.toHaveBeenCalled()
    expect(read.mock.calls[0]).toEqual([
      ['yggdrasil.apiLocationIndication', 'maintenance.enabled', 'maintenance.blockProtocols'],
    ])
  })

  test.each(['admin', 'superadmin', 'user', 'banned', null] as const)('REST 按会话身份放行：%s', async (role) => {
    const { core, getSessionUser } = mockCore({ 'maintenance.enabled': true })
    getSessionUser.mockResolvedValue(
      role ? { uid: 1, sessionId: 1, nickname: 'User', email: 'user@example.test', locale: null, role } : null,
    )
    const response = await createApp({ core }).request('http://example.test/api/openapi.json', {
      headers: { cookie: 'session=placeholder' },
    })
    expect(response.status).toBe(role === 'admin' || role === 'superadmin' ? 200 : 503)
    expect(getSessionUser).toHaveBeenCalledExactlyOnceWith(expect.any(Headers), 'http://example.test')
  })

  test('登录端点始终放行，不查询会话', async () => {
    const { core, getSessionUser, handle } = mockCore({
      'maintenance.enabled': true,
      'maintenance.blockProtocols': true,
    })
    const response = await createApp({ core }).request('http://example.test/api/auth/sign-in/email', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(handle).toHaveBeenCalledOnce()
    expect(getSessionUser).not.toHaveBeenCalled()
  })

  test('协议开关决定 Yggdrasil 是否照常处理，挡住时纯文本 503 并带 ALI', async () => {
    for (const block of [false, true]) {
      const { core, getSessionUser, getSigningKey } = mockCore({
        'maintenance.enabled': true,
        'maintenance.blockProtocols': block,
      })
      getSigningKey.mockResolvedValue({ publicKey: 'test-public-key' } as Awaited<
        ReturnType<Core['yggdrasil']['getSigningKey']>
      >)
      const app = createApp({ core })
      for (const path of ['/api/yggdrasil', '/api/yggdrasil/']) {
        const response = await app.request('http://example.test' + path)
        expect(response.status).toBe(block ? 503 : 200)
        if (block) {
          expect(await response.text()).toBe('Service Unavailable')
          expect(response.headers.get('content-type')).toContain('text/plain')
        } else expect(await response.json()).toHaveProperty('meta.serverName', 'NextSkin')
        expect(response.headers.get('cache-control')).toBe('no-cache, private')
        expect(response.headers.get('x-authlib-injector-api-location')).toBe('http://example.test/api/yggdrasil')
        expect(response.headers.has('retry-after')).toBe(false)
      }
      expect(getSessionUser).not.toHaveBeenCalled()
    }
  })

  test('管理员在游戏服务停用时仍能访问协议', async () => {
    const { core, getSessionUser } = mockCore({ 'maintenance.enabled': true, 'maintenance.blockProtocols': true })
    getSessionUser.mockResolvedValue({
      uid: 1,
      sessionId: 1,
      nickname: 'Admin',
      email: 'admin@example.test',
      locale: null,
      role: 'admin',
    })
    const response = await createApp({ core }).request('http://example.test/Alice.json', {
      headers: { cookie: 'session=placeholder' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('username', 'Alice')
  })

  test('插件路由对匿名返回纯文本 503，ALI 关闭时不加头', async () => {
    const { core, getSessionUser } = mockCore({ 'maintenance.enabled': true, 'yggdrasil.apiLocationIndication': false })
    const response = await createApp({ core }).request('http://example.test/plugins/example/game')
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('Service Unavailable')
    expect(response.headers.get('cache-control')).toBe('no-cache, private')
    expect(response.headers.has('x-authlib-injector-api-location')).toBe(false)
    expect(response.headers.has('retry-after')).toBe(false)
    expect(getSessionUser).not.toHaveBeenCalled()
  })

  test('维护关闭时不检查会话，协议停用开关不起作用', async () => {
    const { core, getSessionUser } = mockCore({ 'maintenance.enabled': false, 'maintenance.blockProtocols': true })
    const app = createApp({ core })
    expect((await app.request('http://example.test/api/openapi.json')).status).toBe(200)
    expect((await app.request('http://example.test/Alice.json')).status).toBe(200)
    expect(getSessionUser).not.toHaveBeenCalled()
  })
})
