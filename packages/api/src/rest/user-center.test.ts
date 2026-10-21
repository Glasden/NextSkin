import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

const player = {
  pid: 12,
  uid: 42,
  name: 'Steve',
  uuid: 'a'.repeat(32),
  skin: null,
  cape: null,
  updatedAt: '2026-10-17T12:00:00.000Z',
}
const signed = { delta: 10, score: 1000, nextAt: '2026-10-18T12:00:00.000Z' }
const endpoints = [
  ['POST', '/api/players', { name: 'Steve' }, 201, 'create', player],
  ['PATCH', '/api/players/12', { name: 'Steve' }, 200, 'update', player],
  ['DELETE', '/api/players/12', undefined, 200, 'delete', { refunded: 100 }],
  ['POST', '/api/user/check-in', undefined, 200, 'checkIn', signed],
] as const
function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi
    .fn()
    .mockResolvedValue({ uid: 42, nickname: 'Steve', email: 'steve@example.test', role: 'user', locale: null })
  const methods = {
    create: vi.fn().mockResolvedValue(player),
    update: vi.fn().mockResolvedValue(player),
    delete: vi.fn().mockResolvedValue({ refunded: 100 }),
    checkIn: vi.fn().mockResolvedValue(signed),
  }
  const core = {
    settings: { read },
    auth: { getSessionUser },
    players: { create: methods.create, update: methods.update, delete: methods.delete },
    users: { checkIn: methods.checkIn },
  } as unknown as Core
  const app = createApp({ core })
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://example.test${path}`, {
      method,
      headers: {
        origin: 'http://example.test',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { app, request, methods, getSessionUser }
}

test.each(endpoints)('%s %s 返回约定响应并只传会话 uid', async (method, path, body, status, fn, expected) => {
  const { request, methods, getSessionUser } = setup()
  const response = await request(method, path, body, { cookie: 'session=placeholder' })
  expect(response.status).toBe(status)
  expect(await response.json()).toEqual(expected)
  expect(getSessionUser).toHaveBeenCalledWith(expect.any(Headers), 'http://example.test')
  const args =
    fn === 'create'
      ? [{ uid: 42 }, body]
      : fn === 'update'
        ? [{ uid: 42 }, 12, body]
        : fn === 'delete'
          ? [{ uid: 42 }, 12]
          : [{ uid: 42 }]
  expect(methods[fn]).toHaveBeenCalledExactlyOnceWith(...args)
})

test.each(endpoints)('%s %s 没有会话返回 401', async (method, path, body, _status, fn) => {
  const { request, methods, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  const response = await request(method, path, body)
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } })
  expect(methods[fn]).not.toHaveBeenCalled()
})

test.each([
  ['unauthenticated', 401],
  ['user_banned', 403],
  ['email_not_verified', 403],
  ['score_insufficient', 403],
  ['player_not_found', 404],
  ['check_in_too_early', 409],
] as const)('领域错误 %s 映射 %s 并本地化', async (code, status) => {
  const { request, methods } = setup()
  const fn = code === 'check_in_too_early' ? 'checkIn' : 'delete'
  methods[fn].mockRejectedValue(new DomainError(code, { required: 100, balance: 0, nextAt: signed.nextAt }))
  const response = await request(
    fn === 'delete' ? 'DELETE' : 'POST',
    fn === 'delete' ? '/api/players/12' : '/api/user/check-in',
    undefined,
    { 'accept-language': 'en' },
  )
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code, message: expect.stringMatching(/[a-z]/i) as unknown } })
})

test.each(['POST', 'PATCH'] as const)('%s 的角色名错误挂在 name 下', async (method) => {
  for (const [code, params] of [
    ['player_name_required', {}],
    ['player_name_invalid', { rule: 'official' }],
    ['player_name_length', { min: 3, max: 16 }],
    ['player_name_taken', {}],
  ] as const) {
    const { request, methods } = setup()
    methods[method === 'POST' ? 'create' : 'update'].mockRejectedValue(new DomainError(code, params))
    const response = await request(method, method === 'POST' ? '/api/players' : '/api/players/12', { name: 'Steve' })
    expect(response.status).toBe(code === 'player_name_taken' ? 409 : 400)
    expect(await response.json()).toMatchObject({
      error: { code, fields: { name: { code, message: expect.any(String) as unknown } } },
    })
  }
  // 规则配置错误是站点的问题，不挂在字段下
  const { request, methods } = setup()
  methods[method === 'POST' ? 'create' : 'update'].mockRejectedValue(new DomainError('player_name_rule_misconfigured'))
  const response = await request(method, method === 'POST' ? '/api/players' : '/api/players/12', { name: 'Steve' })
  expect(response.status).toBe(500)
  expect(await response.json()).not.toHaveProperty('error.fields')
})

test.each(['0', '-1', '1.2', 'abc', '1e2', '9007199254740992', '12x'])(
  'pid %s 格式错误返回 400 invalid_request',
  async (pid) => {
    const { request, methods } = setup()
    for (const method of ['PATCH', 'DELETE']) {
      const response = await request(method, `/api/players/${pid}`, method === 'PATCH' ? { name: 'Steve' } : undefined)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_request', fields: { pid: { code: 'invalid_value' } } },
      })
    }
    expect(methods.update).not.toHaveBeenCalled()
    expect(methods.delete).not.toHaveBeenCalled()
  },
)

test('有请求体必须用 JSON；无请求体的 DELETE 和 POST 不要求 Content-Type', async () => {
  const { request, methods } = setup()
  for (const [method, path, body] of endpoints) {
    const response = await request(method, path, body ?? { unexpected: true }, { 'content-type': 'text/plain' })
    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  }
  expect(methods.delete).not.toHaveBeenCalled()
  expect(methods.checkIn).not.toHaveBeenCalled()
  expect((await request('DELETE', '/api/players/12')).status).toBe(200)
  expect((await request('POST', '/api/user/check-in')).status).toBe(200)
  expect((await request('DELETE', '/api/players/12', undefined, { 'content-type': 'text/plain' })).status).toBe(200)
})

test('空 DELETE 缺少 Origin 被 CSRF 拒绝，同源通过；Sec-Fetch-Site 不能绕过', async () => {
  const { app, request, methods } = setup()
  const response = await app.request('http://example.test/api/players/12', { method: 'DELETE' })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_origin' } })
  expect(methods.delete).not.toHaveBeenCalled()
  for (const origin of ['https://other.example.test', 'http://example.test.evil']) {
    expect(
      (await request('DELETE', '/api/players/12', undefined, { origin, 'sec-fetch-site': 'same-origin' })).status,
    ).toBe(403)
  }
  expect((await request('DELETE', '/api/players/12')).status).toBe(200)
})

test('空 POST 同样检查 Origin，角色 JSON 的类型错误返回字段 name', async () => {
  const { app, request, methods } = setup()
  expect((await app.request('http://example.test/api/user/check-in', { method: 'POST' })).status).toBe(403)
  const invalid = await request('POST', '/api/players', { name: 42 })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({
    error: { code: 'invalid_request', fields: { name: { code: 'invalid_value' } } },
  })
  expect(methods.create).not.toHaveBeenCalled()
})

test('添加角色达到上限时返回本地化 403，不挂在字段下', async () => {
  const { request, methods } = setup()
  methods.create.mockRejectedValue(new DomainError('player_limit_reached', { limit: 1 }))
  const response = await request('POST', '/api/players', { name: 'Steve' }, { 'accept-language': 'en' })
  expect(response.status).toBe(403)
  const body: unknown = await response.json()
  expect(body).toMatchObject({
    error: { code: 'player_limit_reached', message: expect.stringContaining('1') as unknown },
  })
  expect(body).not.toHaveProperty('error.fields')
})
