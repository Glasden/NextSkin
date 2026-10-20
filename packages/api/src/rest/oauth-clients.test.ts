import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

const path = '/api/oauth-clients'
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
}
const input = { name: 'App', type: 'web', redirectUris: ['https://example.test/cb'] }
const endpoints = [
  {
    method: 'GET',
    url: path,
    fn: 'listClients',
    body: undefined,
    args: [42],
    status: 200,
    result: { clients: [client] },
  },
  {
    method: 'POST',
    url: path,
    fn: 'createClient',
    body: input,
    args: [{ uid: 42 }, input],
    status: 201,
    result: { client, clientSecret: 'secret-once' },
  },
  {
    method: 'PATCH',
    url: `${path}/12`,
    fn: 'updateClient',
    body: { name: 'New' },
    args: [{ uid: 42 }, 12, { name: 'New' }],
    status: 200,
    result: client,
  },
  {
    method: 'POST',
    url: `${path}/12/secret`,
    fn: 'resetClientSecret',
    body: undefined,
    args: [{ uid: 42 }, 12],
    status: 200,
    result: { client, clientSecret: 'secret-once' },
  },
  {
    method: 'DELETE',
    url: `${path}/12`,
    fn: 'deleteClient',
    body: undefined,
    args: [{ uid: 42 }, 12],
    status: 204,
    result: undefined,
  },
] as const
function setup() {
  const methods = {
    listClients: vi.fn().mockResolvedValue([client]),
    createClient: vi.fn().mockResolvedValue({ client, clientSecret: 'secret-once' }),
    updateClient: vi.fn().mockResolvedValue(client),
    resetClientSecret: vi.fn().mockResolvedValue({ client, clientSecret: 'secret-once' }),
    deleteClient: vi.fn().mockResolvedValue(undefined),
  }
  const getSessionUser = vi.fn().mockResolvedValue({ uid: 42, role: 'user' })
  const core = {
    settings: {
      read: (keys: CoreSettingKey[]) =>
        Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
    },
    auth: { getSessionUser },
    oauth: methods,
  } as unknown as Core
  const app = createApp({ core })
  const request = (method: string, url: string, body?: unknown, headers = {}) =>
    app.request(`http://example.test${url}`, {
      method,
      headers: {
        origin: 'http://example.test',
        cookie: 'session=placeholder',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { request, methods, getSessionUser }
}
test.each(endpoints)('$method $url 传会话 uid、校验后的输入，返回正确状态和结果', async (endpoint) => {
  const { request, methods } = setup()
  const response = await request(endpoint.method, endpoint.url, endpoint.body)
  expect(response.status).toBe(endpoint.status)
  if (endpoint.status === 204) expect(await response.text()).toBe('')
  else expect(await response.json()).toEqual(endpoint.result)
  expect(methods[endpoint.fn]).toHaveBeenCalledExactlyOnceWith(...endpoint.args)
  if (endpoint.fn === 'createClient' || endpoint.fn === 'resetClientSecret')
    expect(response.headers.get('cache-control')).toBe('no-store')
})
test.each(endpoints)('$method $url 没有会话返回 401', async (endpoint) => {
  const { request, methods, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request(endpoint.method, endpoint.url, endpoint.body)).status).toBe(401)
  expect(methods[endpoint.fn]).not.toHaveBeenCalled()
})
test.each([
  ['POST', path, {}],
  ['POST', path, { ...input, type: 'browser' }],
  ['POST', path, { ...input, name: 1 }],
  ['POST', path, { ...input, redirectUris: 'https://example.com' }],
  ['POST', path, { ...input, redirectUris: [1] }],
  ['POST', path, { ...input, redirectUris: Array.from({ length: 101 }, () => '') }],
  ['POST', path, { ...input, redirectUris: ['a'.repeat(4097)] }],
  ['PATCH', `${path}/12`, {}],
  ['PATCH', `${path}/12`, { redirectUris: [null] }],
  ['PATCH', `${path}/12`, { name: null }],
  ...['0', '-1', '1.2', 'abc', '1e2', '2147483648', '12x'].flatMap(
    (id) =>
      [
        ['PATCH', `${path}/${id}`, { name: 'App' }],
        ['DELETE', `${path}/${id}`, undefined],
        ['POST', `${path}/${id}/secret`, undefined],
      ] as const,
  ),
] as const)('%s %s 拒绝无效参数或请求体', async (method, url, body) => {
  const { request, methods } = setup()
  expect((await request(method, url, body)).status).toBe(400)
  for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled()
})
test('PATCH 可以只传地址；native 创建返回 null 密钥，仍禁止缓存', async () => {
  const { request, methods } = setup()
  expect((await request('PATCH', `${path}/12`, { redirectUris: [] })).status).toBe(200)
  expect(methods.updateClient).toHaveBeenCalledWith({ uid: 42 }, 12, { redirectUris: [] })
  methods.createClient.mockResolvedValue({ client, clientSecret: null })
  const response = await request('POST', path, { ...input, type: 'native', redirectUris: [] })
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ client, clientSecret: null })
  expect(response.headers.get('cache-control')).toBe('no-store')
})
test.each([
  ['oauth_client_not_found', 404, {}],
  ['oauth_client_public', 400, {}],
  ['oauth_client_name_invalid', 400, { min: 1, max: 255 }],
  ['oauth_redirect_uri_invalid', 400, { uri: 'http://bad.test', type: 'web' }],
  ['oauth_redirect_uri_required', 400, {}],
  ['oauth_redirect_uris_too_many', 400, { max: 20 }],
  ['oauth_redirect_uri_too_long', 400, { max: 2048 }],
] as const)('%s 映射状态码', async (code, status, params) => {
  const { request, methods } = setup()
  methods.updateClient.mockRejectedValue(new DomainError(code, params))
  const response = await request('PATCH', `${path}/12`, { name: 'App' })
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code } })
})
test('写操作不接受跨站请求和非 JSON 请求体；Bearer 不能替代会话 Cookie', async () => {
  const { request, methods, getSessionUser } = setup()
  expect(
    (await request('POST', path, input, { origin: 'https://evil.test', 'content-type': 'text/plain' })).status,
  ).toBe(403)
  expect((await request('POST', path, input, { 'content-type': 'text/plain' })).status).toBe(415)
  getSessionUser.mockResolvedValue(null)
  expect((await request('POST', path, input, { cookie: '', authorization: 'Bearer placeholder' })).status).toBe(401)
  expect(methods.createClient).not.toHaveBeenCalled()
})
