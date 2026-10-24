import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { captureLogs } from '@nextskin/logging'
import { beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'
import type { ImportGateway, ImportRunState, ImportStartInput } from '../import-gateway.ts'

function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const core = {
    settings: { read },
    setup: {
      isInitialized: vi.fn().mockResolvedValue(false),
      verifyCode: vi.fn((code: string) => Promise.resolve(code === 'correct' ? 'setup-token' : null)),
      verifySession: vi.fn((token: string) => Promise.resolve(token === 'setup-token')),
      createSite: vi.fn().mockResolvedValue({ uid: 7 }),
    },
    auth: {
      getSessionUser: vi.fn().mockResolvedValue({ uid: 7, email: 'admin@example.test', role: 'superadmin' }),
      createSession: vi.fn().mockResolvedValue(['session=one; HttpOnly', 'other=two; HttpOnly']),
    },
    admin: { requirePermission: vi.fn().mockResolvedValue(undefined) },
    siteImages: { read: vi.fn().mockResolvedValue(Uint8Array.of(137, 80, 78, 71)) },
  }
  const state: ImportRunState = {
    id: 1,
    entry: 'setup',
    dryRun: true,
    status: 'running',
    cancelling: false,
    progress: { stage: 'users', rows: 0, total: 1, files: 0 },
    startedAt: '2026-10-18T00:00:00.000Z',
    finishedAt: null,
    report: null,
  }
  const importer = {
    maintenance: vi.fn().mockReturnValue(false),
    parseEnv: vi.fn().mockReturnValue({
      connection: null,
      prefix: '',
      passwordMethod: null,
      salt: '',
      texturesDirectory: null,
      localTextures: true,
    }),
    check: vi.fn().mockResolvedValue({
      database: {
        status: 'ok',
        bsVersion: '6.0.2',
        counts: { users: 1, players: 0, textures: 0 },
        uuidTable: null,
        descriptions: false,
        unknownTables: [],
      },
      textures: { readable: true, sampled: 0, missing: 0 },
    }),
    start: vi.fn().mockResolvedValue({ token: 'run-token', state }),
    run: vi.fn((token: string) => (token === 'run-token' ? state : null)),
    cancel: vi.fn((token: string) => (token === 'run-token' ? { ...state, cancelling: true } : null)),
    runMarkdown: vi.fn((token: string) => (token === 'run-token' ? '# Report\n' : null)),
    listRuns: vi.fn().mockResolvedValue({ runs: [], total: 0 }),
    getRun: vi.fn().mockResolvedValue(null),
    runMarkdownById: vi.fn().mockResolvedValue(null),
    lastSource: vi.fn().mockResolvedValue(null),
  } satisfies ImportGateway
  const app = createApp({ core: core as unknown as Core, importer })
  const request = (
    method: string,
    path: string,
    body?: unknown,
    cookie = 'nextskin-setup=setup-token',
    headers: Record<string, string> = {},
  ) =>
    app.request(
      `https://example.test${path}`,
      {
        method,
        headers: {
          origin: 'https://example.test',
          'x-forwarded-proto': 'https',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          cookie,
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { peer: '192.0.2.1' },
    )
  return { core, importer, state, app, request }
}
let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
const input: ImportStartInput = {
  connection: { dialect: 'sqlite', file: '/old/bs.sqlite' },
  prefix: '',
  texturesDirectory: '/old/textures',
  timeZone: 'Asia/Shanghai',
  passwordMethod: null,
  salt: 'private-salt',
  dryRun: true,
  siteUrl: null,
  uuidOverrides: {},
  replace: false,
  force: false,
}
const paths = [
  ['/api/setup/code', { code: 'correct' }],
  [
    '/api/setup/site',
    { siteName: 'Site', siteUrl: 'https://example.test', email: 'a@example.test', nickname: 'A', password: 'password' },
  ],
  ['/api/setup/import/env', { text: '', directory: null }],
  ['/api/setup/import/check', input],
  ['/api/setup/import/runs', input],
] as const

test('安装完成之后，向导的全部接口和未知路径都是 404', async () => {
  env.core.setup.isInitialized.mockResolvedValue(true)
  for (const [path, body] of paths) {
    const response = await env.request('POST', path, body)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'setup_completed' } })
  }
  expect((await env.request('GET', '/api/setup/unknown')).status).toBe(404)
  expect(env.importer.start).not.toHaveBeenCalled()
})

test('未验证安装会话的请求被拒绝，安装码错误返回字段错误', async () => {
  for (const [path, body] of paths.slice(1))
    for (const cookie of ['', 'nextskin-setup=wrong']) {
      const response = await env.request('POST', path, body, cookie)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: { code: 'setup_code_required' } })
    }
  const response = await env.request('POST', '/api/setup/code', { code: 'wrong' }, '')
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({
    error: { code: 'setup_code_invalid', fields: { code: { code: 'setup_code_invalid' } } },
  })
})

test('安装码每个 IP 每分钟最多十次，伪造 XFF 不能绕过；Cookie 的安全属性', async () => {
  for (let index = 0; index < 10; index++) {
    const response = await env.request('POST', '/api/setup/code', { code: 'correct' }, '', {
      'x-forwarded-for': `198.51.100.${index}`,
    })
    expect(response.status).toBe(204)
    const cookie = response.headers.get('set-cookie')!
    for (const part of [
      'nextskin-setup=setup-token',
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      'Max-Age=86400',
      'Secure',
    ])
      expect(cookie).toContain(part)
  }
  const limited = await env.request('POST', '/api/setup/code', { code: 'correct' })
  expect(limited.status).toBe(429)
  expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  const insecure = await env.app.request(
    'http://example.test/api/setup/code',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://example.test' },
      body: JSON.stringify({ code: 'correct' }),
    },
    { peer: '192.0.2.2' },
  )
  expect(insecure.status).toBe(204)
  expect(insecure.headers.get('set-cookie')).not.toContain('Secure')
})

test('新站经领域用例创建，自动登录逐个追加 Cookie，清除安装会话；登录失败仍返回已创建', async () => {
  const body = {
    siteName: 'Site',
    siteUrl: 'https://example.test',
    email: ' A@Example.Test ',
    nickname: 'A',
    password: 'password',
  }
  const response = await env.request('POST', '/api/setup/site', body, undefined, { 'accept-language': 'en' })
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ uid: 7, signedIn: true })
  expect(env.core.setup.createSite).toHaveBeenCalledWith({
    ...body,
    setupToken: 'setup-token',
    ip: '192.0.2.1',
    locale: 'en',
  })
  expect(env.core.auth.createSession).toHaveBeenCalledWith(
    expect.objectContaining({ email: 'a@example.test', password: body.password, clientIp: '192.0.2.1' }),
  )
  const cookies = response.headers.getSetCookie()
  expect(cookies).toContain('session=one; HttpOnly')
  expect(cookies).toContain('other=two; HttpOnly')
  expect(cookies.find((cookie) => cookie.startsWith('nextskin-setup='))).toContain('Max-Age=0')
  env.core.auth.createSession.mockRejectedValueOnce(new Error('login failed'))
  const log = captureLogs()
  try {
    expect(await (await env.request('POST', '/api/setup/site', body)).json()).toEqual({ uid: 7, signedIn: false })
  } finally {
    log.restore()
  }
})

test('向导解析、检查、开始导入，运行令牌只放 Cookie；并发运行错误返回 409', async () => {
  expect((await env.request('POST', '/api/setup/import/env', { text: 'x', directory: null })).status).toBe(200)
  expect(env.importer.parseEnv).toHaveBeenCalledWith('x', null)
  expect((await env.request('POST', '/api/setup/import/check', input)).status).toBe(200)
  const response = await env.request('POST', '/api/setup/import/runs', input)
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ run: env.state })
  expect(env.importer.start).toHaveBeenCalledWith(input, { entry: 'setup', startedBy: null })
  for (const part of [
    'nextskin-import-run=run-token',
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=86400',
    'Secure',
  ])
    expect(response.headers.get('set-cookie')).toContain(part)
  env.importer.start.mockRejectedValueOnce(new DomainError('import_running'))
  const busy = await env.request('POST', '/api/setup/import/runs', input)
  expect(busy.status).toBe(409)
  expect(await busy.json()).toMatchObject({ error: { code: 'import_running' } })
})

test('维护分支不读设置；协议返回纯文本，REST 返回本地化 JSON 和 Retry-After', async () => {
  env.importer.maintenance.mockReturnValue(true)
  env.core.settings.read.mockRejectedValue(new Error('must not read settings'))
  for (const path of [
    '/csl/x.json',
    '/api/yggdrasil',
    '/api/yggdrasil/authserver/authenticate',
    '/textures/abc',
    '/render/abc',
    '/api/user',
  ]) {
    const response = await env.request('GET', path, undefined, '', { 'accept-language': 'en' })
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(response.headers.get('cache-control')).toBe('no-cache, private')
    if (path === '/api/user') {
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toMatchObject({
        error: { code: 'maintenance', message: expect.stringContaining('importing data') as unknown },
      })
    } else {
      expect(response.headers.get('content-type')).toContain('text/plain')
      expect(await response.text()).toBe('Service Unavailable')
    }
  }
  expect(env.core.settings.read).not.toHaveBeenCalled()
  for (const path of [
    '/api/health',
    '/api/health/',
    '/api/import/run',
    '/api/import/run/',
    '/api/import/run/report.md',
    // 站点图片只读存储（ADR-0042）
    `/site-images/${'a'.repeat(64)}.png`,
  ])
    expect((await env.request('GET', path, undefined, 'nextskin-import-run=run-token')).status).toBe(200)
  expect((await env.request('POST', '/api/setup/import/env', { text: '', directory: null })).status).toBe(200)
  expect(env.core.settings.read).not.toHaveBeenCalled()
  // 允许的路径也有精确边界，不能用相似前缀绕过维护。
  expect((await env.request('GET', '/api/import/runner')).status).toBe(503)
})

test('运行进度、取消和下载只认运行令牌；结束后取消返回 409，未完成的报告返回 404', async () => {
  for (const cookie of ['', 'nextskin-import-run=wrong']) {
    for (const [method, path] of [
      ['GET', '/api/import/run'],
      ['POST', '/api/import/run/cancel'],
      ['GET', '/api/import/run/report.md'],
    ]) {
      const response = await env.request(method!, path!, undefined, cookie)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: { code: 'import_run_not_found' } })
    }
  }
  const cookie = 'nextskin-import-run=run-token'
  expect(await (await env.request('GET', '/api/import/run', undefined, cookie)).json()).toEqual(env.state)
  expect((await env.request('POST', '/api/import/run/cancel', undefined, cookie)).status).toBe(200)
  const markdown = await env.request('GET', '/api/import/run/report.md', undefined, cookie)
  expect(markdown.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
  expect(markdown.headers.get('content-disposition')).toBe('attachment; filename="import-1.md"')
  env.importer.cancel.mockImplementationOnce(() => {
    throw new DomainError('import_not_running')
  })
  expect((await env.request('POST', '/api/import/run/cancel', undefined, cookie)).status).toBe(409)
  env.importer.runMarkdown.mockReturnValueOnce(null)
  expect((await env.request('GET', '/api/import/run/report.md', undefined, cookie)).status).toBe(404)
  expect(env.core.auth.getSessionUser).not.toHaveBeenCalled()
})

test('每个后台导入接口都要求会话和领域权限，校验前先拒绝无权限访问', async () => {
  const routes = [
    ['POST', '/api/admin/import/env'],
    ['POST', '/api/admin/import/check'],
    ['POST', '/api/admin/import/runs'],
    ['GET', '/api/admin/import/runs'],
    ['GET', '/api/admin/import/runs/1'],
    ['GET', '/api/admin/import/runs/1/report.md'],
  ]
  for (const [method, path] of routes) {
    env.core.auth.getSessionUser.mockResolvedValueOnce(null)
    expect((await env.request(method!, path!, method === 'POST' ? {} : undefined)).status).toBe(401)
    env.core.admin.requirePermission.mockRejectedValueOnce(new DomainError('permission_denied'))
    expect((await env.request(method!, path!, method === 'POST' ? {} : undefined)).status).toBe(403)
  }
  expect(env.core.admin.requirePermission).toHaveBeenCalledTimes(routes.length)
  expect(env.core.admin.requirePermission).toHaveBeenLastCalledWith(7, 'import.manage')
  expect(env.importer.start).not.toHaveBeenCalled()
})

test('后台启动和元数据接口返回服务结果、分页和下载；不存在返回 404', async () => {
  expect((await env.request('POST', '/api/admin/import/env', { text: '', directory: null })).status).toBe(200)
  expect((await env.request('POST', '/api/admin/import/check', input)).status).toBe(200)
  expect((await env.request('POST', '/api/admin/import/runs', input)).status).toBe(202)
  expect(env.importer.start).toHaveBeenCalledWith(input, { entry: 'admin', startedBy: 'admin@example.test' })
  expect(await (await env.request('GET', '/api/admin/import/runs?page=2')).json()).toEqual({ runs: [], total: 0 })
  expect(env.importer.listRuns).toHaveBeenCalledWith(2, 20)
  expect((await env.request('GET', '/api/admin/import/runs')).status).toBe(200)
  expect(env.importer.listRuns).toHaveBeenLastCalledWith(1, 20)
  expect((await env.request('GET', '/api/admin/import/runs/7')).status).toBe(404)
  expect((await env.request('GET', '/api/admin/import/runs/7/report.md')).status).toBe(404)
  env.importer.getRun.mockResolvedValueOnce({ run: { id: 7 }, report: {} })
  expect(await (await env.request('GET', '/api/admin/import/runs/7')).json()).toEqual({ run: { id: 7 }, report: {} })
  env.importer.runMarkdownById.mockResolvedValueOnce('# Stored report')
  const markdown = await env.request('GET', '/api/admin/import/runs/7/report.md')
  expect(markdown.headers.get('content-disposition')).toBe('attachment; filename="import-7.md"')
  expect(await markdown.text()).toBe('# Stored report')
})

test('source 和运行参数在边界校验，错误码保留字段', async () => {
  for (const overrides of [
    { prefix: 'bad-prefix' },
    { connection: { dialect: 'sqlite', file: '' } },
    { connection: { dialect: 'mysql', host: 'x', port: 0, username: '', password: '', database: 'x' } },
    { uuidOverrides: { abc: 'uuid' } },
    { uuidOverrides: { '1': 'x'.repeat(65) } },
  ]) {
    expect((await env.request('POST', '/api/setup/import/runs', { ...input, ...overrides })).status).toBe(400)
  }
  env.importer.start.mockRejectedValueOnce(new DomainError('import_timezone_invalid', undefined, ['timeZone']))
  const response = await env.request('POST', '/api/setup/import/runs', input)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { code: 'import_timezone_invalid', fields: { timeZone: { code: 'import_timezone_invalid' } } },
  })
})

test('只有开始运行的请求体放宽至 1 MB，仍执行 Content-Type 和 CSRF 检查', async () => {
  const big = {
    ...input,
    uuidOverrides: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [String(index), 'a'.repeat(32)])),
  }
  expect(JSON.stringify(big).length).toBeGreaterThan(16 * 1024)
  for (const entry of ['setup', 'admin']) {
    expect((await env.request('POST', `/api/${entry}/import/runs`, big)).status).toBe(202)
    expect(
      (await env.request('POST', `/api/${entry}/import/runs`, { ...input, padding: 'a'.repeat(1024 * 1024) })).status,
    ).toBe(413)
    expect((await env.request('POST', `/api/${entry}/import/check`, big)).status).toBe(413)
  }
  expect(
    (await env.request('POST', '/api/setup/import/runs', input, undefined, { 'content-type': 'text/plain' })).status,
  ).toBe(415)
  expect(
    (
      await env.request('POST', '/api/import/run/cancel', {}, 'nextskin-import-run=run-token', {
        'content-type': 'text/plain',
        origin: 'https://evil.test',
      })
    ).status,
  ).toBe(403)
})

test('没有导入服务时仍可创建新站，导入路由不注册', async () => {
  const app = createApp({ core: env.core as unknown as Core })
  expect(app.routes.some((route) => route.path === '/api/setup/code')).toBe(true)
  expect(app.routes.some((route) => /\/import\//.test(route.path))).toBe(false)
  const response = await app.request(
    'http://example.test/api/setup/code',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://example.test' },
      body: JSON.stringify({ code: 'correct' }),
    },
    { peer: '192.0.2.1' },
  )
  expect(response.status).toBe(204)
})

test('导入期间不能创建新站，不调用领域建站或登录', async () => {
  env.importer.maintenance.mockReturnValue(true)
  const response = await env.request('POST', '/api/setup/site', {
    siteName: 'Site',
    siteUrl: 'https://example.test',
    email: 'a@example.test',
    nickname: 'A',
    password: 'password',
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'import_running' } })
  expect(env.core.setup.createSite).not.toHaveBeenCalled()
  expect(env.core.auth.createSession).not.toHaveBeenCalled()
})

test('维护期间放行路径的校验、Content-Type 和领域错误也不读取设置', async () => {
  env.importer.maintenance.mockReturnValue(true)
  env.core.settings.read.mockRejectedValue(new Error('must not read settings'))
  const invalid = await env.request('POST', '/api/setup/import/env', {})
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_request' } })
  const unsupported = await env.request('POST', '/api/import/run/cancel', 'nonempty', 'nextskin-import-run=run-token', {
    'content-type': 'text/plain',
  })
  expect(unsupported.status).toBe(415)
  expect(await unsupported.json()).toMatchObject({ error: { code: 'invalid_request' } })
  const missing = await env.request('GET', '/api/import/run', undefined, '')
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ error: { code: 'import_run_not_found' } })
  expect(env.core.settings.read).not.toHaveBeenCalled()
})

test('后台任务无法暂停时把 import_jobs_busy 原样返回为 409', async () => {
  env.importer.start.mockRejectedValueOnce(new DomainError('import_jobs_busy'))
  const response = await env.request('POST', '/api/setup/import/runs', input)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'import_jobs_busy' } })
})
