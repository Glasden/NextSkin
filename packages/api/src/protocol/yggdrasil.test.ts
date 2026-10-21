import {
  coreSettingsRegistry,
  DomainError,
  YggdrasilError,
  type Core,
  type CoreSettingKey,
  type PlayerView,
} from '@nextskin/domain'
import { createTranslator } from '@nextskin/i18n'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

const prefix = '/api/yggdrasil'
const profilePath = `${prefix}/api/user/profile/${'a'.repeat(32)}/skin`
const player: PlayerView = {
  pid: 1,
  name: 'Steve',
  uuid: 'a'.repeat(32),
  updatedAt: '2026-10-18T00:00:00.000Z',
  ownerBanned: false,
  skin: { tid: 1, hash: 'b'.repeat(64), type: 'steve' },
  cape: null,
}
const auth = { accessToken: 'token', clientToken: 'client', availableProfiles: [] }

function setup(settings: Partial<Record<CoreSettingKey, unknown>> = {}) {
  const methods = {
    authenticate: vi.fn().mockResolvedValue(auth),
    refresh: vi.fn().mockResolvedValue(auth),
    validate: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
    signout: vi.fn().mockResolvedValue(undefined),
    join: vi.fn().mockResolvedValue(undefined),
    hasJoined: vi.fn().mockResolvedValue(null),
    getSigningKey: vi.fn().mockResolvedValue({ publicKey: 'public', sign: (value: string) => `signed:${value}` }),
    resetTexture: vi.fn().mockResolvedValue(undefined),
    uploadTexture: vi.fn(async (_input: unknown, beforeUpload: (uid: number) => Promise<void>) => {
      try {
        await beforeUpload(42)
      } catch (error) {
        if (error instanceof DomainError)
          throw new YggdrasilError('ForbiddenOperationException', `errors.${error.code}`, 'en', error.params)
        throw error
      }
    }),
  }
  const upload = vi.fn().mockResolvedValue({ texture: {}, charged: 0 })
  const openIdConfigurationUrl = vi.fn().mockResolvedValue(null)
  const core = {
    settings: {
      read: (keys: CoreSettingKey[]) =>
        Promise.resolve(
          Object.fromEntries(keys.map((key) => [key, settings[key] ?? coreSettingsRegistry[key].default])),
        ),
    },
    yggdrasil: methods,
    players: { findByUuid: vi.fn().mockResolvedValue(player) },
    auth: { openIdConfigurationUrl, getSessionUser: vi.fn().mockResolvedValue({ uid: 42 }) },
    textures: { upload },
  } as unknown as Core
  const app = createApp({ core })
  const request = (path: string, body: unknown = {}, headers = {}) =>
    app.request(`http://example.test${prefix}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  const form = (size = 10) => {
    const body = new FormData()
    body.set('file', new File([new Uint8Array(size)], 'skin.png', { type: 'image/png' }))
    body.set('model', ' slim ')
    return body
  }
  return { app, request, methods, form, upload, openIdConfigurationUrl }
}

test('authserver 递归 trim，保留原密码；异常字符串参数交给领域层为 null', async () => {
  const { request, methods } = setup()
  expect(
    (
      await request('/authserver/authenticate', {
        username: ' Steve\t',
        password: ' secret\n',
        clientToken: 12,
        requestUser: 'false',
      })
    ).status,
  ).toBe(200)
  expect(methods.authenticate).toHaveBeenCalledWith({
    username: 'Steve',
    ip: null,
    password: 'secret',
    rawPassword: ' secret\n',
    clientToken: null,
    requestUser: true,
  })
  expect(
    (
      await request('/authserver/refresh', {
        accessToken: [],
        clientToken: {},
        selectedProfile: { id: ' abc ', name: '\t' },
        requestUser: '0',
      })
    ).status,
  ).toBe(200)
  expect(methods.refresh).toHaveBeenCalledWith({
    accessToken: null,
    clientToken: null,
    selectedProfile: { id: 'abc', name: null },
    requestUser: false,
    ip: null,
  })
  await request('/authserver/signout', { username: 12, password: ['secret'] })
  expect(methods.signout).toHaveBeenCalledWith({ username: null, password: null, rawPassword: null })
})

test.each(['{', 'null', '[]', 'true', '42', '"text"'])('非法或非对象 JSON %s 当作空对象', async (body) => {
  const { app, methods } = setup()
  expect(
    (
      await app.request(`http://example.test${prefix}/authserver/authenticate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    ).status,
  ).toBe(200)
  expect(methods.authenticate).toHaveBeenCalledWith({
    ip: null,
    username: null,
    password: null,
    rawPassword: null,
    clientToken: null,
    requestUser: false,
  })
})

test.each([
  [true, true],
  [1, true],
  [-1, true],
  ['false', true],
  ['x', true],
  [[0], true],
  [{ a: false }, true],
  [false, false],
  [0, false],
  ['0', false],
  [null, false],
  [[], false],
  [{}, false],
  [' \t', false],
])('requestUser %j 按 PHP 解析为 %s', async (requestUser, expected) => {
  const { request, methods } = setup()
  await request('/authserver/authenticate', { requestUser })
  expect(methods.authenticate).toHaveBeenCalledWith(expect.objectContaining({ requestUser: expected }))
})

test.each([
  ['IllegalArgumentException', 400],
  ['UnauthorizedException', 401],
  ['ForbiddenOperationException', 403],
  ['NotFoundException', 404],
] as const)('%s 返回 %s、不带 ALI，并优先使用用户语言', async (kind, status) => {
  const { request, methods } = setup({ 'site.locale': 'zh-CN' })
  methods.validate.mockRejectedValue(new YggdrasilError(kind, 'yggdrasil.errors.token_invalid', 'en-US'))
  const response = await request('/authserver/validate')
  expect(response.status).toBe(status)
  expect(response.headers.has('x-authlib-injector-api-location')).toBe(false)
  expect(await response.json()).toEqual({
    error: kind,
    errorMessage: createTranslator('en')('yggdrasil.errors.token_invalid'),
  })
})

test('未知用户的错误与非 JSON 响应用站点语言；非 JSON 响应带 ALI；未知异常不泄露内容', async () => {
  const { request, methods } = setup({ 'site.locale': 'zh-CN' })
  methods.validate.mockRejectedValue(
    new YggdrasilError('ForbiddenOperationException', 'yggdrasil.errors.token_invalid', 'unsupported'),
  )
  expect(await (await request('/authserver/validate', {}, { 'accept-language': 'en' })).json()).toEqual({
    error: 'ForbiddenOperationException',
    errorMessage: createTranslator('zh-CN')('yggdrasil.errors.token_invalid'),
  })
  const unsupported = await request('/authserver/authenticate', {}, { 'content-type': 'text/plain' })
  expect(unsupported.status).toBe(200)
  expect(unsupported.headers.get('x-authlib-injector-api-location')).toBe(`http://example.test${prefix}`)
  expect(await unsupported.json()).toEqual({
    error: 'Unsupported Media Type',
    errorMessage: createTranslator('zh-CN')('yggdrasil.errors.content_type'),
  })
  expect(methods.authenticate).not.toHaveBeenCalled()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    methods.validate.mockRejectedValue(new Error('sensitive password token otp'))
    const failed = await request('/authserver/validate')
    expect(failed.status).toBe(500)
    expect(await failed.text()).toBe('Internal Server Error')
    expect(log).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})

test('join 接受表单并 trim，只采信受信代理的 IP；其他 Content-Type 当作空对象', async () => {
  const { app, methods } = setup({ 'network.trustedProxies': ['192.0.2.1'] })
  for (const peer of ['192.0.2.1', '192.0.2.2']) {
    const response = await app.request(
      `http://example.test${prefix}/sessionserver/session/minecraft/join`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7' },
        body: 'accessToken=old&accessToken=%20token%20&selectedProfile=%20uuid%20&serverId=%20%20',
      },
      { peer },
    )
    expect(response.status).toBe(204)
    expect(methods.join).toHaveBeenLastCalledWith({
      accessToken: 'token',
      selectedProfile: 'uuid',
      serverId: null,
      ip: peer === '192.0.2.1' ? '198.51.100.7' : peer,
    })
  }
  await app.request(`http://example.test${prefix}/sessionserver/session/minecraft/join`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{"accessToken":"token"}',
  })
  expect(methods.join).toHaveBeenLastCalledWith({ accessToken: null, selectedProfile: null, serverId: null, ip: null })
})

test('hasJoined 参数取最后一个、数组不当作字符串；成功签名并使用站点地址，缺密钥返回 400', async () => {
  const { app, methods } = setup({ 'site.url': 'http://site.test/base' })
  const url = `http://example.test${prefix}/sessionserver/session/minecraft/hasJoined?username=old&username=%20Steve%20&serverId[]=x&ip=%20`
  methods.hasJoined.mockResolvedValue(player)
  const response = await app.request(url, { headers: { 'x-forwarded-proto': 'https' } })
  expect(methods.hasJoined).toHaveBeenCalledWith({ username: 'Steve', serverId: null, ip: null })
  expect(response.status).toBe(200)
  expect(response.headers.get('x-authlib-injector-api-location')).toBe('https://site.test/base/api/yggdrasil')
  const body = (await response.json()) as { properties: { value: string; signature: string }[] }
  for (const property of body.properties) expect(property.signature).toBe(`signed:${property.value}`)
  expect(JSON.parse(Buffer.from(body.properties[0]!.value, 'base64').toString())).toMatchObject({
    textures: { SKIN: { url: `https://site.test/base/textures/${'b'.repeat(64)}` } },
  })
  methods.getSigningKey.mockResolvedValue(null)
  const missing = await app.request(url)
  expect(missing.status).toBe(400)
  expect(missing.headers.has('x-authlib-injector-api-location')).toBe(false)
})

test.each([
  ['Basic token', null],
  ['bearer token', null],
  ['Bearer first, Bearer last, ignored', 'last'],
  ['prefix Bearer token', 'token'],
  ['Bearer ,ignored', ''],
])('Authorization %s 按 Laravel 提取令牌', async (authorization, accessToken) => {
  const { app, methods } = setup()
  expect(
    (await app.request(`http://example.test${profilePath}`, { method: 'DELETE', headers: { authorization } })).status,
  ).toBe(204)
  expect(methods.resetTexture).toHaveBeenCalledWith({ accessToken, uuid: 'a'.repeat(32), type: 'skin' })
})

test('multipart 文件字节、文件名与 model 原样传递；缺文件由领域层处理', async () => {
  const { app, methods, form } = setup()
  for (const body of [form(), new FormData()]) {
    expect(
      (
        await app.request(`http://example.test${profilePath}`, {
          method: 'PUT',
          headers: { authorization: 'Bearer token' },
          body,
        })
      ).status,
    ).toBe(204)
  }
  expect(methods.uploadTexture).toHaveBeenNthCalledWith(
    1,
    {
      accessToken: 'token',
      uuid: 'a'.repeat(32),
      type: 'skin',
      model: ' slim ',
      file: { bytes: new Uint8Array(10), filename: 'skin.png' },
    },
    expect.any(Function),
  )
  expect(methods.uploadTexture).toHaveBeenNthCalledWith(
    2,
    { accessToken: 'token', uuid: 'a'.repeat(32), type: 'skin', model: null, file: null },
    expect.any(Function),
  )
})

test('文件大小、表单 Content-Length 与实际流大小各自限制为 400，超限不调用领域层', async () => {
  const { app, methods, form } = setup({ 'texture.maxFileSizeKb': 1 })
  for (const [size, headers] of [
    [1025, {}],
    [10, { 'content-length': '100000' }],
    [100000, { 'content-length': '1' }],
    [100000, {}],
  ] as const) {
    const response = await app.request(`http://example.test${profilePath}`, {
      method: 'PUT',
      body: form(size),
      headers,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: 'IllegalArgumentException',
      errorMessage: createTranslator('zh-CN')('errors.texture_file_too_large', { max: 1 }),
    })
    expect(response.headers.has('x-authlib-injector-api-location')).toBe(false)
  }
  expect(methods.uploadTexture).not.toHaveBeenCalled()
})

test('网页和启动器共用 uid 的每分钟 10 次限额；鉴权失败不消耗次数', async () => {
  const { app, methods, form, upload } = setup()
  const put = () => app.request(`http://example.test${profilePath}`, { method: 'PUT', body: form() })
  methods.uploadTexture.mockRejectedValueOnce(
    new YggdrasilError('UnauthorizedException', 'yggdrasil.errors.token_unauthorized'),
  )
  expect((await put()).status).toBe(401)
  for (let i = 0; i < 5; i++) {
    expect((await put()).status).toBe(204)
    const body = form()
    body.set('name', 'Test')
    body.set('type', 'steve')
    body.set('public', 'true')
    expect(
      (
        await app.request('http://example.test/api/textures', {
          method: 'POST',
          headers: { origin: 'http://example.test' },
          body,
        })
      ).status,
    ).toBe(201)
  }
  const limited = await put()
  expect(limited.status).toBe(403)
  expect(limited.headers.get('retry-after')).toBeTruthy()
  expect(limited.headers.has('x-authlib-injector-api-location')).toBe(false)
  expect(await limited.json()).toMatchObject({
    error: 'ForbiddenOperationException',
    errorMessage: createTranslator('en')('errors.too_many_requests'),
  })
  expect(
    (
      await app.request('http://example.test/api/textures', {
        method: 'POST',
        headers: { origin: 'http://example.test' },
        body: form(),
      })
    ).status,
  ).toBe(429)
  expect(upload).toHaveBeenCalledTimes(5)
})

test('上传路径 OPTIONS 和 405 返回两种方法；不读取文件也不调用领域层', async () => {
  const { app, methods } = setup()
  for (const [method, status, allow] of [
    ['OPTIONS', 200, 'PUT,DELETE'],
    ['POST', 405, 'PUT, DELETE'],
    ['HEAD', 405, 'PUT, DELETE'],
  ] as const) {
    const response = await app.request(`http://example.test${profilePath}`, { method })
    expect(response.status).toBe(status)
    expect(response.headers.get('allow')).toBe(allow)
  }
  expect(methods.uploadTexture).not.toHaveBeenCalled()
  expect(methods.resetTexture).not.toHaveBeenCalled()
})

test.each([null, 'https://skin.example.test/api/auth/.well-known/openid-configuration'])(
  '元数据的发现地址取自认证服务：%s',
  async (url) => {
    const { app, openIdConfigurationUrl } = setup()
    openIdConfigurationUrl.mockResolvedValue(url)
    const response = await app.request('http://example.test/api/yggdrasil', {
      headers: { 'x-forwarded-proto': 'https' },
    })
    const body = (await response.json()) as { meta: Record<string, unknown> }
    if (url) expect(body.meta['feature.openid_configuration_url']).toBe(url)
    else expect(body.meta).not.toHaveProperty('feature.openid_configuration_url')
  },
)

test.each(['authenticate', 'refresh'] as const)('%s 拒绝显示插件 message，返回 403', async (action) => {
  const { request, methods } = setup()
  methods[action].mockRejectedValue(
    new YggdrasilError('ForbiddenOperationException', 'yggdrasil.errors.plugin_denied', 'en', {
      message: '请先绑定 QQ',
    }),
  )
  const response = await request(`/authserver/${action}`)
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'ForbiddenOperationException', errorMessage: '请先绑定 QQ' })
})
