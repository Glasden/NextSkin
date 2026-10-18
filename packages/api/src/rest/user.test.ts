import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { Hono } from 'hono'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'
import type { AppEnv } from '../env.ts'
import { createRestApp } from './app.ts'
import { createMemoryRateLimiter, type RateLimiter } from './rate-limit.ts'

const user = {
  uid: 42,
  nickname: 'Steve',
  role: 'user',
  avatarTid: null,
  registeredAt: '2026-10-17T12:00:00.000Z',
  email: 'steve@example.test',
  emailVerified: true,
  score: 1000,
  locale: 'zh-CN',
}
const endpoints = [
  ['PATCH', '/api/user', { nickname: 'Steve', locale: 'en' }, 200, 'updateProfile', user],
  [
    'POST',
    '/api/user/email',
    { email: 'new@example.test', password: 'secret-password' },
    202,
    'changeEmail',
    { pendingEmail: 'new@example.test' },
  ],
  [
    'POST',
    '/api/user/email/confirm',
    { token: 'signed-token' },
    200,
    'confirmEmailChange',
    { email: 'new@example.test' },
  ],
  ['DELETE', '/api/user', { password: 'secret-password' }, 200, 'deleteAccount', {}],
] as const
function setup(rateLimiter?: RateLimiter) {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi.fn().mockResolvedValue(user)
  const clearSessionCookies = vi
    .fn()
    .mockResolvedValue([
      'nextskin.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
      'nextskin.session_data=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
    ])
  const methods = {
    updateProfile: vi.fn().mockResolvedValue(user),
    changeEmail: vi.fn().mockResolvedValue({ status: 'pending', pendingEmail: 'new@example.test' }),
    confirmEmailChange: vi.fn().mockResolvedValue({ email: 'new@example.test' }),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
  }
  const core = { settings: { read }, auth: { getSessionUser, clearSessionCookies }, users: methods } as unknown as Core
  const app = rateLimiter
    ? new Hono<AppEnv>()
        .use('*', async (c, next) => {
          c.set('requestRoot', 'http://example.test')
          await next()
        })
        .route('/api', createRestApp(core, { rateLimiter }))
    : createApp({ core })
  const request = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://example.test${path}`, {
      method,
      headers: { origin: 'http://example.test', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  return { app, request, methods, getSessionUser, clearSessionCookies }
}

test.each(endpoints)('%s %s 返回约定响应，只接受会话 uid', async (method, path, body, status, fn, expected) => {
  const { request, methods, getSessionUser } = setup()
  const response = await request(
    method,
    path,
    { ...body, uid: 999, role: 'superadmin' },
    { cookie: 'session=placeholder' },
  )
  expect(response.status).toBe(status)
  expect(await response.json()).toEqual(expected)
  if (fn === 'confirmEmailChange') {
    expect(methods[fn]).toHaveBeenCalledExactlyOnceWith('signed-token')
    expect(getSessionUser).not.toHaveBeenCalled()
  } else {
    expect(getSessionUser).toHaveBeenCalledWith(expect.any(Headers), 'http://example.test')
    expect(methods[fn]).toHaveBeenCalledExactlyOnceWith(
      { uid: 42 },
      body,
      ...(fn === 'changeEmail' ? ['http://example.test'] : []),
    )
  }
})

test.each(endpoints.filter((e) => e[4] !== 'confirmEmailChange'))(
  '%s %s 没会话返回 401，不调用用例',
  async (method, path, body, _status, fn) => {
    const { request, methods, getSessionUser } = setup()
    getSessionUser.mockResolvedValue(null)
    const response = await request(method, path, body)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } })
    expect(methods[fn]).not.toHaveBeenCalled()
  },
)

test('确认邮箱无需会话，未配置邮件的改邮箱返回 200 PrivateUser', async () => {
  const { request, methods, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request('POST', '/api/user/email/confirm', { token: 'signed-token' })).status).toBe(200)
  expect(getSessionUser).not.toHaveBeenCalled()
  getSessionUser.mockResolvedValue(user)
  methods.changeEmail.mockResolvedValue({ status: 'changed', user })
  const response = await request('POST', '/api/user/email', { email: 'new@example.test', password: 'secret-password' })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(user)
})

test.each([
  ['password_incorrect', 400, 'password'],
  ['email_unchanged', 400, 'email'],
  ['locale_invalid', 400, 'locale'],
  ['email_change_link_invalid', 400, null],
  ['admin_cannot_delete_self', 403, null],
  ['user_banned', 403, null],
  ['email_invalid', 400, 'email'],
  ['email_domain_not_allowed', 400, 'email'],
  ['email_taken', 409, 'email'],
  ['nickname_invalid', 400, 'nickname'],
] as const)('错误 %s 映射状态 %s 与字段 %s', async (code, status, field) => {
  const { request, methods } = setup()
  methods.updateProfile.mockRejectedValue(new DomainError(code, { min: 1, max: 255 }))
  const response = await request('PATCH', '/api/user', { nickname: 'Steve' }, { 'accept-language': 'en' })
  expect(response.status).toBe(status)
  const body = (await response.json()) as { error: { code: string; fields?: unknown } }
  expect(body).toMatchObject({ error: { code, message: expect.stringMatching(/[a-z]/i) as unknown } })
  if (field) expect(body.error.fields).toMatchObject({ [field]: { code } })
  else expect(body.error).not.toHaveProperty('fields')
})

test.each(endpoints)('%s %s 类型错误不调用用例', async (method, path, _body, _status, fn) => {
  const { request, methods } = setup()
  const body = { nickname: 123, locale: false, email: false, token: 123, password: 123 }
  const response = await request(method, path, body)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  expect(methods[fn]).not.toHaveBeenCalled()
})

test('默认限流：第 4 次 429、Retry-After 秒数；两个接口共用 uid 计数，限流后不用例', async () => {
  const { request, methods } = setup()
  // 即使密码不对也要计数。
  methods.changeEmail.mockRejectedValue(new DomainError('password_incorrect'))
  for (let i = 0; i < 3; i++)
    expect((await request('POST', '/api/user/email', { email: 'new@example.test', password: 'wrong' })).status).toBe(
      400,
    )
  const response = await request('DELETE', '/api/user', { password: 'wrong' })
  expect(response.status).toBe(429)
  expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
  expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(10)
  expect(await response.json()).toMatchObject({ error: { code: 'too_many_requests' } })
  expect(methods.changeEmail).toHaveBeenCalledTimes(3)
  expect(methods.deleteAccount).not.toHaveBeenCalled()
})

test('可注入时钟：按 uid 隔离，10 秒后恢复；个人资料和确认不占密码窗口', async () => {
  let now = 1000
  const { request, methods, getSessionUser } = setup(createMemoryRateLimiter(() => now))
  for (let i = 0; i < 3; i++) expect((await request('DELETE', '/api/user', { password: 'wrong' })).status).toBe(200)
  expect((await request('POST', '/api/user/email', { email: 'new@example.test', password: 'wrong' })).status).toBe(429)
  expect(methods.changeEmail).not.toHaveBeenCalled()
  expect((await request('PATCH', '/api/user', {})).status).toBe(200)
  expect((await request('POST', '/api/user/email/confirm', { token: 'signed-token' })).status).toBe(200)
  getSessionUser.mockResolvedValue({ ...user, uid: 43 })
  expect((await request('DELETE', '/api/user', { password: 'wrong' })).status).toBe(200)
  getSessionUser.mockResolvedValue(user)
  now += 10_000
  expect((await request('POST', '/api/user/email', { email: 'new@example.test', password: 'wrong' })).status).toBe(202)
})

test('DELETE 返回所有清 Cookie 的 Set-Cookie 头；失败不会清 Cookie', async () => {
  const { request, methods, clearSessionCookies } = setup()
  const response = await request(
    'DELETE',
    '/api/user',
    { password: 'secret-password' },
    { cookie: 'nextskin.session_token=original' },
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({})
  expect(response.headers.getSetCookie()).toEqual((await clearSessionCookies.mock.results[0]!.value) as string[])
  expect(clearSessionCookies).toHaveBeenCalledExactlyOnceWith(expect.any(Headers), 'http://example.test')
  const headers = clearSessionCookies.mock.calls[0]![0] as Headers
  expect(headers.get('cookie')).toBe('nextskin.session_token=original')
  clearSessionCookies.mockClear()
  methods.deleteAccount.mockRejectedValue(new DomainError('admin_cannot_delete_self'))
  const failure = await request('DELETE', '/api/user', { password: 'secret-password' })
  expect(failure.status).toBe(403)
  expect(failure.headers.getSetCookie()).toEqual([])
  expect(clearSessionCookies).not.toHaveBeenCalled()
})

test('OpenAPI 包含四个接口、202/429 和响应头', async () => {
  const { app } = setup()
  const response = await app.request('http://example.test/api/openapi.json')
  expect(response.status).toBe(200)
  const spec = (await response.json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { headers?: Record<string, unknown> }> }>>
  }
  expect(spec.paths['/user']?.patch).toBeDefined()
  expect(spec.paths['/user']?.delete?.responses['200']?.headers).toHaveProperty('Set-Cookie')
  expect(spec.paths['/user/email']?.post?.responses['202']).toBeDefined()
  expect(spec.paths['/user/email']?.post?.responses['429']?.headers).toHaveProperty('Retry-After')
  expect(spec.paths['/user/email/confirm']?.post).toBeDefined()
})

test('可注入异步限流驱动，被拒绝时也不调用用例', async () => {
  const consume = vi.fn().mockResolvedValue({ allowed: false, retryAfter: 7 })
  const { request, methods } = setup({ consume })
  const response = await request('DELETE', '/api/user', { password: 'secret-password' })
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('7')
  expect(consume).toHaveBeenCalledExactlyOnceWith('42')
  expect(methods.deleteAccount).not.toHaveBeenCalled()
})

test('同一 uid 四个并发请求，恰好三个进入用例、一个 429', async () => {
  const { request, methods } = setup()
  const gate = Promise.withResolvers<unknown>()
  methods.changeEmail.mockReturnValue(gate.promise)
  const requests = Array.from({ length: 4 }, () =>
    Promise.resolve(request('POST', '/api/user/email', { email: 'new@example.test', password: 'secret-password' })),
  )
  try {
    const rejected = await Promise.race(requests)
    expect(rejected.status).toBe(429)
    expect(await rejected.json()).toMatchObject({ error: { code: 'too_many_requests' } })
    expect(methods.changeEmail).toHaveBeenCalledTimes(3)
  } finally {
    gate.resolve({ status: 'pending', pendingEmail: 'new@example.test' })
  }
  expect((await Promise.all(requests)).map((r) => r.status).sort()).toEqual([202, 202, 202, 429])
  expect(methods.changeEmail).toHaveBeenCalledTimes(3)
})
