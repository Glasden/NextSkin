import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { createTranslator, getMessages, locales, type Locale } from '@nextskin/i18n'
import { expect, test, vi, type Mock } from 'vitest'
import { createApp } from '../app.ts'

const methods = ['updatePlayer', 'transferPlayer', 'deletePlayer', 'lookupUser', 'textureForOwner'] as const
type Method = (typeof methods)[number]
const player = {
  pid: 7,
  uid: 8,
  name: 'Steve',
  uuid: '0123456789abcdef0123456789abcdef',
  skin: 3,
  cape: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
}
/** 会话的 uid 和对端地址：写接口的用例从这里拿操作者，读接口只拿 uid */
const actor = { uid: 42, ip: '192.0.2.10' }
interface Endpoint {
  method: string
  path: string
  body?: unknown
  fn: Method
  /** 用例收到的全部参数 */
  args: unknown[]
  result: unknown
}
const endpoints: Endpoint[] = [
  {
    method: 'PATCH',
    path: '/admin/players/7',
    body: { name: 'Alex', skin: 3, cape: null },
    fn: 'updatePlayer',
    args: [actor, 7, { name: 'Alex', skin: 3, cape: null }],
    result: player,
  },
  {
    method: 'POST',
    path: '/admin/players/7/transfer',
    body: { uid: 9 },
    fn: 'transferPlayer',
    args: [actor, 7, 9],
    result: { ...player, uid: 9 },
  },
  { method: 'DELETE', path: '/admin/players/7', fn: 'deletePlayer', args: [actor, 7], result: {} },
  {
    method: 'GET',
    path: '/admin/users/lookup?q=target%40example.test',
    fn: 'lookupUser',
    args: [actor.uid, 'target@example.test'],
    result: { uid: 9, nickname: 'Target', email: 'target@example.test', role: 'user', avatar: null },
  },
  {
    method: 'GET',
    path: '/admin/textures/3?owner=9',
    fn: 'textureForOwner',
    args: [actor.uid, 3, 9],
    result: {
      tid: 3,
      name: 'Skin',
      type: 'steve',
      public: true,
      uploaderId: 8,
      hash: 'a'.repeat(64),
      scale: 1,
      visibleToOwner: true,
    },
  },
  {
    method: 'GET',
    path: '/admin/textures/3?owner=9',
    fn: 'textureForOwner',
    args: [actor.uid, 3, 9],
    // 别人的私有材质，操作者没有 textures.manage
    result: { tid: 3, public: false, visibleToOwner: false },
  },
]

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

test.each(endpoints)('$method $path 返回用例的结果', async (endpoint) => {
  const { request, admin } = setup()
  admin[endpoint.fn].mockResolvedValue(endpoint.fn === 'deletePlayer' ? undefined : endpoint.result)
  const response = await request(endpoint.method, endpoint.path, endpoint.body)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(endpoint.result)
  expect(admin[endpoint.fn]).toHaveBeenCalledExactlyOnceWith(...endpoint.args)
})

test.each(endpoints)('$method $path 没有会话返回 401，不调用用例', async (endpoint) => {
  const { request, admin, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  const response = await request(endpoint.method, endpoint.path, endpoint.body)
  expect(response.status).toBe(401)
  for (const name of methods) expect(admin[name]).not.toHaveBeenCalled()
})

test.each([
  ['PATCH 空对象', 'PATCH', '/admin/players/7', {}],
  ['PATCH 名字不是字符串', 'PATCH', '/admin/players/7', { name: 1 }],
  ['PATCH 材质编号是 0', 'PATCH', '/admin/players/7', { skin: 0 }],
  ['PATCH 材质编号是小数', 'PATCH', '/admin/players/7', { cape: 1.5 }],
  ['PATCH 材质编号超过上界', 'PATCH', '/admin/players/7', { skin: 2147483648 }],
  ['PATCH 材质编号是字符串', 'PATCH', '/admin/players/7', { skin: '3' }],
  ['转让缺 uid', 'POST', '/admin/players/7/transfer', {}],
  ['转让的 uid 是字符串', 'POST', '/admin/players/7/transfer', { uid: '9' }],
  ['转让的 uid 超过上界', 'POST', '/admin/players/7/transfer', { uid: 2147483648 }],
  ['查用户缺 q', 'GET', '/admin/users/lookup', undefined],
  ['查用户的 q 为空', 'GET', '/admin/users/lookup?q=', undefined],
  ['查用户的 q 超过 255 个字符', 'GET', `/admin/users/lookup?q=${'a'.repeat(256)}`, undefined],
  ['查材质缺 owner', 'GET', '/admin/textures/3', undefined],
  ['查材质的 owner 不是正整数', 'GET', '/admin/textures/3?owner=0', undefined],
  ['查材质的 owner 超过上界', 'GET', '/admin/textures/3?owner=2147483648', undefined],
  ...['0', '-1', '1.2', '1e2', '2147483648', '7x'].flatMap(
    (value) =>
      [
        [`pid 为 ${value}`, 'PATCH', `/admin/players/${value}`, { name: 'Alex' }],
        [`转让的 pid 为 ${value}`, 'POST', `/admin/players/${value}/transfer`, { uid: 9 }],
        [`删除的 pid 为 ${value}`, 'DELETE', `/admin/players/${value}`, undefined],
        [`查材质的 tid 为 ${value}`, 'GET', `/admin/textures/${value}?owner=9`, undefined],
      ] as const,
  ),
] as const)('%s：400 invalid_request，不调用用例', async (_name, method, path, body) => {
  const { request, admin } = setup()
  const response = await request(method, path, body)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  for (const name of methods) expect(admin[name]).not.toHaveBeenCalled()
})

const failures = [
  ['permission_denied', 403, 'updatePlayer', {}],
  ['user_not_manageable', 403, 'updatePlayer', {}],
  ['player_not_found', 404, 'updatePlayer', {}],
  ['player_name_taken', 409, 'updatePlayer', {}],
  ['player_name_invalid', 400, 'updatePlayer', { rule: 'official' }],
  ['texture_not_found', 404, 'updatePlayer', {}],
  ['texture_type_mismatch', 400, 'updatePlayer', { slot: 'cape' }],
  ['player_not_found', 404, 'transferPlayer', {}],
  ['user_not_found', 404, 'transferPlayer', {}],
  ['user_not_manageable', 403, 'transferPlayer', {}],
  ['player_transfer_limit_reached', 403, 'transferPlayer', { limit: 1 }],
  ['player_not_found', 404, 'deletePlayer', {}],
  ['permission_denied', 403, 'lookupUser', {}],
  ['user_not_found', 404, 'lookupUser', {}],
  ['user_not_manageable', 403, 'textureForOwner', {}],
  ['texture_not_found', 404, 'textureForOwner', {}],
] as const
test.each(failures)('%s（%s）由 %s 抛出时映射状态码，按路径选文案', async (code, status, fn, params) => {
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

test('OpenAPI 声明这些接口；材质的路径同时有查询、修改和删除', async () => {
  const { app } = setup()
  const spec = (await (await app.request('http://example.test/api/openapi.json')).json()) as {
    paths: Record<string, object>
  }
  expect(Object.keys(spec.paths['/admin/players/{pid}']!).sort()).toEqual(['delete', 'patch'])
  expect(Object.keys(spec.paths['/admin/players/{pid}/transfer']!)).toEqual(['post'])
  expect(Object.keys(spec.paths['/admin/users/lookup']!)).toEqual(['get'])
  expect(Object.keys(spec.paths['/admin/textures/{tid}']!).sort()).toEqual(['delete', 'get', 'patch'])
})
