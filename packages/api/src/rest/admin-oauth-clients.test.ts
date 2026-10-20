import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

const path = '/api/admin/oauth-clients'
const actor = { uid: 42, ip: '192.0.2.10' }
const client = {
  id: 12,
  clientId: 'a'.repeat(32),
  name: 'App',
  type: 'web',
  redirectUris: ['https://example.test/cb'],
  deviceCode: false,
  disabled: false,
  createdAt: '2026-10-20T00:00:00.000Z',
  authorizedUsers: 2,
  shared: false,
  owner: { uid: 7, nickname: 'Owner', role: 'user' },
}
const endpoints = [
  {
    method: 'GET',
    url: `${path}?q=app&owner=7&page=2`,
    fn: 'listOAuthClients',
    args: [42, { q: 'app', owner: 7, page: 2 }],
    result: { total: 1, items: [client], owner: { uid: 7, nickname: 'Owner' } },
  },
  {
    method: 'POST',
    url: `${path}/12/disable`,
    fn: 'disableOAuthClient',
    args: [actor, 12],
    result: { ...client, disabled: true },
  },
  { method: 'POST', url: `${path}/12/enable`, fn: 'enableOAuthClient', args: [actor, 12], result: client },
  { method: 'DELETE', url: `${path}/12`, fn: 'deleteOAuthClient', args: [actor, 12], result: {} },
] as const
function setup() {
  const methods = {
    listOAuthClients: vi.fn(),
    disableOAuthClient: vi.fn(),
    enableOAuthClient: vi.fn(),
    deleteOAuthClient: vi.fn(),
  }
  const getSessionUser = vi.fn().mockResolvedValue({ uid: 42, role: 'admin' })
  const core = {
    settings: {
      read: (keys: CoreSettingKey[]) =>
        Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
    },
    auth: { getSessionUser },
    admin: methods,
  } as unknown as Core
  const app = createApp({ core })
  const request = (method: string, url: string) =>
    app.request(
      `http://example.test${url}`,
      { method, headers: { origin: 'http://example.test', cookie: 'session=placeholder' } },
      { peer: actor.ip },
    )
  return { request, methods, getSessionUser }
}
test.each(endpoints)('$method $url 传会话 actor 和参数，不要求请求体', async (endpoint) => {
  const { request, methods } = setup()
  methods[endpoint.fn].mockResolvedValue(endpoint.fn === 'deleteOAuthClient' ? undefined : endpoint.result)
  const response = await request(endpoint.method, endpoint.url)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(endpoint.result)
  expect(methods[endpoint.fn]).toHaveBeenCalledExactlyOnceWith(...endpoint.args)
})
test.each(endpoints)('$method $url 无会话返回 401', async (endpoint) => {
  const { request, methods, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request(endpoint.method, endpoint.url)).status).toBe(401)
  expect(methods[endpoint.fn]).not.toHaveBeenCalled()
})
test('列表省略 page 时用 1，owner 不存在时保留 null', async () => {
  const { request, methods } = setup()
  methods.listOAuthClients.mockResolvedValue({ total: 0, items: [], owner: null })
  const response = await request('GET', `${path}?owner=999`)
  expect(await response.json()).toEqual({ total: 0, items: [], owner: null })
  expect(methods.listOAuthClients).toHaveBeenCalledExactlyOnceWith(42, { owner: 999, page: 1 })
})
test.each([
  ...['0', '-1', '1.2', 'abc', '1e2', '2147483648', '12x'].flatMap(
    (id) =>
      [
        ['POST', `${path}/${id}/disable`],
        ['POST', `${path}/${id}/enable`],
        ['DELETE', `${path}/${id}`],
        ['GET', `${path}?owner=${id}`],
        ['GET', `${path}?page=${id}`],
      ] as const,
  ),
  ['GET', `${path}?q=${'a'.repeat(256)}`],
] as const)('%s %s 拒绝无效参数', async (method, url) => {
  const { request, methods } = setup()
  expect((await request(method, url)).status).toBe(400)
  for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled()
})
test.each([
  ['oauth_client_not_found', 404],
  ['oauth_client_shared', 403],
  ['oauth_client_not_manageable', 403],
  ['user_not_manageable', 403],
  ['permission_denied', 403],
] as const)('%s 返回对应错误', async (code, status) => {
  const { request, methods } = setup()
  methods.deleteOAuthClient.mockRejectedValue(new DomainError(code))
  const response = await request('DELETE', `${path}/12`)
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code } })
})
