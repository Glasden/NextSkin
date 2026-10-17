import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { createTranslator } from '@nextskin/i18n'
import { expect, test, vi } from 'vitest'
import { errorSchema } from './errors.ts'
import { createApp } from '../app.ts'

function setup(stored: Partial<Record<CoreSettingKey, unknown>> = {}) {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, stored[key] ?? coreSettingsRegistry[key].default]))),
  )
  const register = vi.fn().mockResolvedValue({ uid: 42 })
  const createSession = vi
    .fn()
    .mockResolvedValue(['nextskin.session_token=one; HttpOnly; SameSite=Lax', 'other=two; HttpOnly'])
  const handle = vi.fn().mockResolvedValue(new Response('ok'))
  const core = { settings: { read }, users: { register }, auth: { createSession, handle } } as unknown as Core
  const app = createApp({ core })
  const body = { email: 'test@example.test', password: 'password', playerName: 'Test' }
  const request = (
    data: unknown = body,
    headers: Record<string, string> = {},
    peer: string | null = '::ffff:127.0.0.1',
  ) =>
    app.request(
      'http://example.test/api/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://example.test', ...headers },
        body: JSON.stringify(data),
      },
      { peer },
    )
  return { app, read, register, createSession, handle, body, request }
}

test('注册转交类型化参数、可信 IP 和显式语言，逐个追加 Cookie；OpenAPI 可读取', async () => {
  const { app, register, createSession, body, request } = setup()
  const response = await request(body, {
    'x-forwarded-for': '203.0.113.1',
    cookie: 'nextskin-locale=zh-TW',
    'accept-language': 'en',
    'user-agent': 'test-agent',
  })
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ uid: 42, signedIn: true })
  expect(register).toHaveBeenCalledWith({ ...body, ip: '203.0.113.1', locale: 'zh-CN' })
  expect(createSession).toHaveBeenCalledWith({
    email: body.email,
    password: body.password,
    clientIp: '203.0.113.1',
    userAgent: 'test-agent',
    requestRoot: 'http://example.test',
  })
  expect(response.headers.getSetCookie()).toEqual([
    'nextskin.session_token=one; HttpOnly; SameSite=Lax',
    'other=two; HttpOnly',
  ])
  const doc = await app.request('http://example.test/api/openapi.json')
  expect(doc.status).toBe(200)
  expect(await doc.json()).toMatchObject({ paths: { '/register': { post: { requestBody: { required: true } } } } })
})

test.each([
  [{}, null],
  [{ 'accept-language': 'en-US' }, 'en'],
  [{ cookie: 'nextskin-locale=unknown', 'accept-language': 'en' }, 'en'],
  [{ 'accept-language': 'de' }, null],
] as const)('注册只保存用户实际选择的语言 %j', async (headers, locale) => {
  const { request, register } = setup({ 'site.locale': 'en' })
  expect((await request(undefined, headers)).status).toBe(201)
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ locale }))
})

test('对端未知时 503，不调用注册；不受信任的对端不能伪造 XFF', async () => {
  const { request, register } = setup()
  const response = await request(undefined, { 'x-forwarded-for': '1.1.1.1' }, null)
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: { code: 'service_unavailable' } })
  expect(register).not.toHaveBeenCalled()
  expect((await request(undefined, { 'x-forwarded-for': '1.1.1.1' }, '198.51.100.1')).status).toBe(201)
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ ip: '198.51.100.1' }))
})

test('app.request 没有 Bindings 时安全返回 503；auth 同样使用解析器', async () => {
  const { app, body, handle } = setup()
  expect(
    (
      await app.request('/api/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(503)
  await app.request('/api/auth/get-session', { headers: { 'x-forwarded-for': '203.0.113.3' } }, { peer: '127.0.0.1' })
  expect(handle).toHaveBeenLastCalledWith(expect.any(Request), 'http://localhost', '203.0.113.3')
})

test.each([
  ['email_invalid', 400, 'email', {}],
  ['email_domain_not_allowed', 400, 'email', {}],
  ['email_taken', 409, 'email', {}],
  ['password_too_short', 400, 'password', { min: 8 }],
  ['password_too_long', 400, 'password', { max: 128 }],
  ['nickname_invalid', 400, 'nickname', { min: 1, max: 255 }],
  ['player_name_required', 400, 'playerName', {}],
  ['player_name_invalid', 400, 'playerName', { rule: 'official' }],
  ['player_name_length', 400, 'playerName', { min: 3, max: 16 }],
  ['player_name_taken', 409, 'playerName', {}],
  ['registration_disabled', 403, undefined, {}],
  ['ip_limit_reached', 403, undefined, { limit: 3 }],
] as const)('领域错误 %s → %s，带本地化字段错误', async (code, status, field, params) => {
  const { register, request, createSession } = setup()
  register.mockRejectedValue(new DomainError(code, params))
  const response = await request(undefined, { 'accept-language': 'en' })
  expect(response.status).toBe(status)
  const result = errorSchema.parse(await response.json())
  expect(result.error.code).toBe(code)
  expect(result.error.message).toMatch(/[A-Za-z]/)
  if (field) expect(result.error.fields).toEqual({ [field]: { code, message: result.error.message } })
  else expect(result.error.fields).toBeUndefined()
  expect(createSession).not.toHaveBeenCalled()
})

test('请求语言遵循 Cookie、Accept-Language、站点默认顺序', async () => {
  const { request, register } = setup({ 'site.locale': 'en' })
  register.mockRejectedValue(new DomainError('email_taken'))
  expect(await (await request()).json()).toMatchObject({
    error: { message: createTranslator('en')('errors.email_taken') },
  })
  const response = await request(undefined, { cookie: 'nextskin-locale=zh-CN', 'accept-language': 'en' })
  expect(errorSchema.parse(await response.json()).error.message).toMatch(/[\u4e00-\u9fff]/)
})

test('角色名规则配置错误返回 500 和给管理员的说明，不当成未知异常', async () => {
  const { request, register } = setup()
  register.mockRejectedValue(new DomainError('player_name_rule_misconfigured'))
  const response = await request(undefined, { 'accept-language': 'en' })
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({
    error: {
      code: 'player_name_rule_misconfigured',
      message: createTranslator('en')('errors.player_name_rule_misconfigured'),
    },
  })
})

test.each([new DomainError('unknown'), new Error('SECRET_CANARY')])(
  '内部异常只返回通用 500，日志只写类型',
  async (error) => {
    const { request, register } = setup()
    register.mockRejectedValue(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await request(undefined, { 'accept-language': 'en' })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: { code: 'internal_error', message: createTranslator('en')('errors.internal_error') },
      })
      expect(log.mock.calls).toEqual([[`[rest] unhandled ${error.name}`]])
    } finally {
      log.mockRestore()
    }
  },
)

test('建会话失败仍然 201，无 Cookie，不泄露错误内容', async () => {
  const { request, createSession } = setup()
  createSession.mockRejectedValue(new Error('SECRET_CANARY'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const response = await request()
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ uid: 42, signedIn: false })
    expect(response.headers.getSetCookie()).toEqual([])
    expect(log.mock.calls).toEqual([['[rest] unhandled Error']])
  } finally {
    log.mockRestore()
  }
})

test('zod 校验失败只给每个顶层字段一个通用错误，不回显输入', async () => {
  const { request, register } = setup()
  const response = await request(
    { email: 42, password: null, nickname: false, playerName: [] },
    { 'accept-language': 'en' },
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: {
      code: 'invalid_request',
      message: createTranslator('en')('errors.invalid_request'),
      fields: Object.fromEntries(
        ['email', 'password', 'nickname', 'playerName'].map((name) => [
          name,
          { code: 'invalid_value', message: createTranslator('en')('errors.invalid_value') },
        ]),
      ),
    },
  })
  expect(register).not.toHaveBeenCalled()
})

test('只校验类型，业务规则交由领域用例', async () => {
  const { request, register } = setup()
  expect((await request({ email: '', password: '' })).status).toBe(201)
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ email: '', password: '' }))
})

test('text/plain 的合法 JSON 被拒绝；CSRF 只拦表单类且严格匹配站点 origin', async () => {
  const { request, register } = setup({ 'site.url': 'https://skin.example.test/subpath' })
  const wrongType = await request(undefined, { 'content-type': 'text/plain', origin: 'https://skin.example.test' })
  expect(wrongType.status).toBe(415)
  expect(await wrongType.json()).toMatchObject({ error: { code: 'invalid_request' } })
  for (const origin of ['http://example.test', 'https://skin.example.test.evil', 'http://skin.example.test']) {
    const response = await request(undefined, { 'content-type': 'text/plain', origin, 'sec-fetch-site': 'same-origin' })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_origin' } })
  }
  expect(register).not.toHaveBeenCalled()
  expect((await request(undefined, { origin: 'https://other.example.test' })).status).toBe(201)
})

test('坏 JSON → 400；16 KiB 上限检查 Content-Length 和流', async () => {
  const { app, request, register } = setup()
  const malformed = await app.request(
    '/api/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' },
    { peer: '127.0.0.1' },
  )
  expect(malformed.status).toBe(400)
  expect(await malformed.json()).toMatchObject({ error: { code: 'invalid_request' } })
  for (const headers of [{}, { 'content-length': '20000' }] as Record<string, string>[]) {
    const response = await request({ password: 'x'.repeat(17000) }, headers)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: 'request_too_large' } })
  }
  expect(register).not.toHaveBeenCalled()
})
