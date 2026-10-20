import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

const path = '/api/user/authorizations'
const authorizations = [
  {
    id: 12,
    client: { id: 12, clientId: 'shared', name: null, shared: true, owner: null },
    scopes: ['openid'],
    players: [{ pid: 3, name: 'Steve' }],
    authorizedAt: '2026-10-18T00:00:00.000Z',
  },
]
const endpoints = [
  ['GET', path, 200, 'listAuthorizations', [42]],
  ['DELETE', `${path}/12`, 204, 'revokeAuthorization', [42, 12]],
] as const
function setup() {
  const methods = {
    listAuthorizations: vi.fn().mockResolvedValue(authorizations),
    revokeAuthorization: vi.fn().mockResolvedValue(undefined),
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
  const request = (method: string, url: string, headers = {}, body?: string) =>
    app.request(`http://example.test${url}`, {
      method,
      body,
      headers: {
        origin: 'http://example.test',
        'content-type': 'application/json',
        cookie: 'session=placeholder',
        ...headers,
      },
    })
  return { app, request, methods, getSessionUser }
}

test.each(endpoints)('%s %s 只传会话 uid，DELETE 不要求请求体', async (method, url, status, fn, args) => {
  const { request, methods } = setup()
  const response = await request(method, url)
  expect(response.status).toBe(status)
  if (method === 'GET') expect(await response.json()).toEqual({ authorizations })
  else expect(await response.text()).toBe('')
  expect(methods[fn]).toHaveBeenCalledExactlyOnceWith(...args)
})

test.each(endpoints)('%s %s 无会话 401', async (method, url, _status, fn) => {
  const { request, methods, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request(method, url)).status).toBe(401)
  expect(methods[fn]).not.toHaveBeenCalled()
})

test.each(['0', '-1', '1.2', 'abc', '1e2', '9007199254740992', '12x'])('id %s 必须是安全正整数', async (id) => {
  const { request, methods } = setup()
  expect((await request('DELETE', `${path}/${id}`)).status).toBe(400)
  expect(methods.revokeAuthorization).not.toHaveBeenCalled()
})

test('取消授权幂等；跨站和缺 Content-Type 返回 403/415', async () => {
  const { app, request, methods } = setup()
  expect((await request('DELETE', `${path}/999`)).status).toBe(204)
  expect(methods.revokeAuthorization).toHaveBeenCalledWith(42, 999)
  expect((await app.request(`http://example.test${path}/12`, { method: 'DELETE' })).status).toBe(403)
  expect(
    (
      await request('DELETE', `${path}/12`, {
        origin: 'https://evil.test',
        'sec-fetch-site': 'same-origin',
        'content-type': 'text/plain',
      })
    ).status,
  ).toBe(403)
  expect((await request('DELETE', `${path}/12`, { 'content-type': '' }, '{}')).status).toBe(415)
})

test('领域错误按现有映射返回', async () => {
  const { request, methods } = setup()
  methods.revokeAuthorization.mockRejectedValue(new DomainError('unauthenticated'))
  const response = await request('DELETE', `${path}/12`)
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } })
})
