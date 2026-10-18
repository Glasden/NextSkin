import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

const item = {
  tid: 7,
  name: 'Mine',
  textureName: 'Skin',
  type: 'steve',
  hash: 'a'.repeat(64),
  scale: 1,
  public: true,
  scorePaid: 3,
  addedAt: '2026-10-18T00:00:00.000Z',
}
const report = { id: 9, tid: 7, reason: 'Reason', status: 'pending', scorePaid: 2, createdAt: item.addedAt }
const endpoints = [
  ['GET', '/api/closet', undefined, 200, 'list', { items: [item], total: 1 }, [42, { type: 'skin', page: 1 }]],
  ['POST', '/api/closet', { tid: 7, name: 'Mine' }, 201, 'add', item, [{ uid: 42 }, { tid: 7, name: 'Mine' }]],
  ['PATCH', '/api/closet/7', { name: 'Mine' }, 200, 'rename', item, [{ uid: 42 }, 7, { name: 'Mine' }]],
  ['DELETE', '/api/closet/7', undefined, 200, 'remove', { refunded: 3 }, [{ uid: 42 }, 7]],
  [
    'POST',
    '/api/reports',
    { tid: 7, reason: 'Reason' },
    201,
    'create',
    report,
    [{ uid: 42 }, { tid: 7, reason: 'Reason' }],
  ],
  [
    'PATCH',
    '/api/players/8',
    { name: 'New', skin: 7, cape: null },
    200,
    'update',
    { pid: 8 },
    [{ uid: 42 }, 8, { name: 'New', skin: 7, cape: null }],
  ],
  [
    'PATCH',
    '/api/user',
    { nickname: 'New', locale: 'en', avatar: 7 },
    200,
    'updateProfile',
    { uid: 42 },
    [{ uid: 42 }, { nickname: 'New', locale: 'en', avatar: 7 }],
  ],
] as const
function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi.fn().mockResolvedValue({ uid: 42, nickname: 'User', role: 'user', locale: null })
  const methods = {
    list: vi.fn().mockResolvedValue({ items: [item], total: 1 }),
    add: vi.fn().mockResolvedValue(item),
    rename: vi.fn().mockResolvedValue(item),
    remove: vi.fn().mockResolvedValue({ refunded: 3 }),
    create: vi.fn().mockResolvedValue(report),
    update: vi.fn().mockResolvedValue({ pid: 8 }),
    updateProfile: vi.fn().mockResolvedValue({ uid: 42 }),
  }
  const core = {
    settings: { read },
    auth: { getSessionUser },
    closet: methods,
    reports: { create: methods.create },
    players: { update: methods.update },
    users: { updateProfile: methods.updateProfile },
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
  return { app, methods, getSessionUser, request }
}

test.each(endpoints)(
  '%s %s 状态码、响应和会话 uid；忽略伪造 uid/role',
  async (method, path, body, status, fn, expected, args) => {
    const { request, methods } = setup()
    const response = await request(
      method,
      path,
      body === undefined ? undefined : { ...body, uid: 999, role: 'superadmin' },
    )
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual(expected)
    expect(methods[fn]).toHaveBeenCalledExactlyOnceWith(...args)
  },
)

test.each(endpoints)('%s %s 没有会话返回 401', async (method, path, body, _status, fn) => {
  const { request, methods, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request(method, path, body)).status).toBe(401)
  expect(methods[fn]).not.toHaveBeenCalled()
})

test('衣柜列表解析查询参数；换材质和头像接受 null', async () => {
  const { request, methods } = setup()
  expect((await request('GET', '/api/closet?type=cape&q=Hello&page=2')).status).toBe(200)
  expect(methods.list).toHaveBeenCalledExactlyOnceWith(42, { type: 'cape', q: 'Hello', page: 2 })
  expect((await request('PATCH', '/api/players/8', { skin: null, cape: 7 })).status).toBe(200)
  expect(methods.update).toHaveBeenCalledExactlyOnceWith({ uid: 42 }, 8, { skin: null, cape: 7 })
  expect((await request('PATCH', '/api/user', { avatar: null })).status).toBe(200)
  expect(methods.updateProfile).toHaveBeenCalledExactlyOnceWith({ uid: 42 }, { avatar: null })
})

test.each([0, -1, 1.2, 2147483648, '7', null])('新增 tid 请求体拒绝 %j，返回 invalid_request', async (tid) => {
  const { request, methods } = setup()
  for (const [method, path, body] of [
    ['POST', '/api/closet', { tid }],
    ['POST', '/api/reports', { tid, reason: 'Reason' }],
    ...(tid === null
      ? []
      : [
          ['PATCH', '/api/players/8', { skin: tid }],
          ['PATCH', '/api/players/8', { cape: tid }],
          ['PATCH', '/api/user', { avatar: tid }],
        ]),
  ] as const) {
    const response = await request(method as string, path as string, body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  }
  for (const fn of ['add', 'create', 'update', 'updateProfile'] as const) expect(methods[fn]).not.toHaveBeenCalled()
})

test.each(['0', '-1', '1.2', '2147483648', '1e2', '7x'])('衣柜路径 tid %s 无效', async (tid) => {
  const { request, methods } = setup()
  expect((await request('PATCH', `/api/closet/${tid}`, { name: 'Name' })).status).toBe(400)
  expect((await request('DELETE', `/api/closet/${tid}`)).status).toBe(400)
  expect(methods.rename).not.toHaveBeenCalled()
  expect(methods.remove).not.toHaveBeenCalled()
})

test.each(['type=other', 'page=0', 'page=-1', 'page=1.2', 'page=1e2', `q=${'a'.repeat(65)}`])(
  '衣柜查询 %s 无效',
  async (query) => {
    const { request, methods } = setup()
    expect((await request('GET', `/api/closet?${query}`)).status).toBe(400)
    expect(methods.list).not.toHaveBeenCalled()
  },
)

test.each([
  ['closet_item_exists', 409, 'add', 'POST', '/api/closet', { tid: 7 }, {}],
  ['closet_item_not_found', 404, 'remove', 'DELETE', '/api/closet/7', undefined, {}],
  ['texture_type_mismatch', 400, 'update', 'PATCH', '/api/players/8', { skin: 7 }, { slot: 'skin' }],
  ['texture_not_found', 404, 'updateProfile', 'PATCH', '/api/user', { avatar: 7 }, {}],
  ['report_duplicate', 409, 'create', 'POST', '/api/reports', { tid: 7, reason: 'Reason' }, {}],
  ['report_reason_length', 400, 'create', 'POST', '/api/reports', { tid: 7, reason: '' }, { min: 1, max: 500 }],
  ['user_banned', 403, 'add', 'POST', '/api/closet', { tid: 7 }, {}],
  ['email_not_verified', 403, 'create', 'POST', '/api/reports', { tid: 7, reason: 'Reason' }, {}],
] as const)('%s 正确映射到 %s 并本地化', async (code, status, fn, method, path, body, params) => {
  const { request, methods } = setup()
  methods[fn].mockRejectedValue(new DomainError(code, params))
  const response = await request(method, path, body, { 'accept-language': 'en' })
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({
    error: {
      code,
      message: expect.stringMatching(/[a-z]/i) as unknown,
      ...(code === 'report_reason_length' ? { fields: { reason: { code } } } : {}),
    },
  })
})

test('新写接口沿用 CSRF、JSON 和请求体上限；OpenAPI 包含新路由', async () => {
  const { request, app, methods } = setup()
  for (const [method, path, body] of endpoints.filter(([method]) => method !== 'GET')) {
    expect(
      (await request(method, path, body, { origin: 'https://other.test', 'content-type': 'text/plain' })).status,
    ).toBe(403)
    if (body !== undefined)
      expect((await request(method, path, body, { 'content-type': 'text/plain' })).status).toBe(415)
  }
  expect((await request('POST', '/api/reports', { tid: 7, reason: 'x'.repeat(17 * 1024) })).status).toBe(413)
  expect(methods.create).not.toHaveBeenCalled()
  const response = await app.request('http://example.test/api/openapi.json')
  expect(response.status).toBe(200)
  const spec = (await response.json()) as { paths: Record<string, unknown> }
  for (const path of ['/closet', '/closet/{tid}', '/reports', '/players/{pid}', '/user'])
    expect(spec.paths[path]).toBeDefined()
})
