import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { createTranslator, getMessages, locales, type Locale } from '@nextskin/i18n'
import { expect, test, vi, type Mock } from 'vitest'
import { createApp } from '../app.ts'

const methods = ['addClosetItem', 'removeClosetItem'] as const
type Method = (typeof methods)[number]
const actor = { uid: 42, ip: '192.0.2.10' }
const item = {
  tid: 7,
  name: '衣柜名',
  scorePaid: 0,
  addedAt: '2026-01-01T00:00:00.000Z',
  visibleToOwner: true,
  texture: { name: '材质名', type: 'steve', hash: 'a'.repeat(64), scale: 1, public: true },
}
const endpoints = [
  {
    method: 'POST',
    path: '/admin/users/8/closet',
    body: { tid: 7, name: '衣柜名' },
    fn: 'addClosetItem',
    args: [actor, 8, { tid: 7, name: '衣柜名' }],
    status: 201,
    result: item,
  },
  {
    method: 'DELETE',
    path: '/admin/users/8/closet/7',
    body: undefined,
    fn: 'removeClosetItem',
    args: [actor, 8, 7],
    status: 200,
    result: { refunded: 5 },
  },
] as const

function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi.fn().mockResolvedValue({
    uid: actor.uid,
    sessionId: 1,
    nickname: 'Admin',
    email: 'admin@example.test',
    role: 'admin',
    locale: null,
  })
  const admin = Object.fromEntries(methods.map((name) => [name, vi.fn()])) as Record<Method, Mock>
  const core = { settings: { read }, auth: { getSessionUser }, admin } as unknown as Core
  const app = createApp({ core })
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(
      `http://example.test/api${path}`,
      {
        method,
        headers: {
          origin: 'http://example.test',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { peer: actor.ip },
    )
  return { app, request, admin, getSessionUser }
}
function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  return (createTranslator(locale) as unknown as (key: string, params?: Record<string, string | number>) => string)(
    key,
    params,
  )
}

test.each(endpoints)('$method $path 返回用例结果，主人和操作者分别传入', async (endpoint) => {
  const { request, admin } = setup()
  admin[endpoint.fn].mockResolvedValue(endpoint.result)
  const response = await request(endpoint.method, endpoint.path, endpoint.body)
  expect(response.status).toBe(endpoint.status)
  expect(await response.json()).toEqual(endpoint.result)
  expect(admin[endpoint.fn]).toHaveBeenCalledExactlyOnceWith(...endpoint.args)
})

test('名字可省略，id 接受有符号整数上界', async () => {
  const { request, admin } = setup()
  admin.addClosetItem.mockResolvedValue(item)
  expect((await request('POST', '/admin/users/2147483647/closet', { tid: 2147483647 })).status).toBe(201)
  expect(admin.addClosetItem).toHaveBeenCalledExactlyOnceWith(actor, 2147483647, { tid: 2147483647 })
})

const invalid = [
  ['缺少请求体', 'POST', '/admin/users/8/closet', undefined],
  ['空请求体', 'POST', '/admin/users/8/closet', {}],
  ['名字不是字符串', 'POST', '/admin/users/8/closet', { tid: 7, name: null }],
  ...[0, -1, 1.2, 2147483648, '7', null].map(
    (tid) => [`请求体的 tid 为 ${tid}`, 'POST', '/admin/users/8/closet', { tid }] as const,
  ),
  ...['0', '-1', '1.2', '1e2', '2147483648', '7x'].flatMap(
    (id) =>
      [
        [`加入的 uid 为 ${id}`, 'POST', `/admin/users/${id}/closet`, { tid: 7 }],
        [`移出的 uid 为 ${id}`, 'DELETE', `/admin/users/${id}/closet/7`, undefined],
        [`移出的 tid 为 ${id}`, 'DELETE', `/admin/users/8/closet/${id}`, undefined],
      ] as const,
  ),
] as const
const failures = [
  ['permission_denied', 403, 'addClosetItem', {}],
  ['user_not_manageable', 403, 'addClosetItem', {}],
  ['user_not_found', 404, 'addClosetItem', {}],
  ['texture_not_found', 404, 'addClosetItem', {}],
  ['closet_item_exists', 409, 'addClosetItem', {}],
  ['texture_name_invalid', 400, 'addClosetItem', {}],
  ['permission_denied', 403, 'removeClosetItem', {}],
  ['user_not_manageable', 403, 'removeClosetItem', {}],
  ['user_not_found', 404, 'removeClosetItem', {}],
  ['closet_item_not_found', 404, 'removeClosetItem', {}],
] as const

test.each(endpoints)('$method $path 没有会话返回 401，不调用用例', async (endpoint) => {
  const { request, admin, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  const response = await request(endpoint.method, endpoint.path, endpoint.body)
  expect(response.status).toBe(401)
  for (const name of methods) expect(admin[name]).not.toHaveBeenCalled()
})

test.each(invalid)('%s：400 invalid_request，不调用用例', async (_name, method, path, body) => {
  const { request, admin } = setup()
  const response = await request(method, path, body)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  for (const name of methods) expect(admin[name]).not.toHaveBeenCalled()
})

test.each(failures)('%s（%s）由 %s 抛出时映射状态码和文案', async (code, status, fn, params) => {
  const endpoint = endpoints.find((candidate) => candidate.fn === fn)!
  for (const locale of locales) {
    const { request, admin } = setup()
    admin[fn].mockRejectedValue(new DomainError(code, params))
    const response = await request(endpoint.method, endpoint.path, endpoint.body, { 'accept-language': locale })
    expect(response.status).toBe(status)
    const override: Record<string, string> = getMessages(locale).admin.errors
    expect(await response.json()).toMatchObject({
      error: {
        code,
        message: translate(locale, Object.hasOwn(override, code) ? `admin.errors.${code}` : `errors.${code}`, params),
      },
    })
  }
})

test('OpenAPI 声明衣柜加入和移出接口', async () => {
  const { app } = setup()
  const spec = (await (await app.request('http://example.test/api/openapi.json')).json()) as {
    paths: Record<string, object>
  }
  expect(Object.keys(spec.paths['/admin/users/{uid}/closet']!)).toEqual(['post'])
  expect(Object.keys(spec.paths['/admin/users/{uid}/closet/{tid}']!)).toEqual(['delete'])
})
