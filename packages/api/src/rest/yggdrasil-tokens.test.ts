import { coreSettingsRegistry, type Core, type CoreSettingKey } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

const path = '/api/user/yggdrasil-tokens'
const tokens = [
  {
    id: 12,
    createdAt: '2026-10-18T00:00:00.000Z',
    validUntil: '2026-10-21T00:00:00.000Z',
    expiresAt: '2026-10-25T00:00:00.000Z',
    player: { pid: 3, name: 'Steve' },
    status: 'valid',
  },
]
const endpoints = [
  ['GET', path, 200, 'listTokens', [42]],
  ['DELETE', `${path}/12`, 204, 'revokeToken', [42, 12]],
  ['DELETE', path, 204, 'revokeAllTokens', [42]],
] as const

function setup() {
  const methods = {
    listTokens: vi.fn().mockResolvedValue(tokens),
    revokeToken: vi.fn().mockResolvedValue(undefined),
    revokeAllTokens: vi.fn().mockResolvedValue(undefined),
  }
  const getSessionUser = vi.fn().mockResolvedValue({ uid: 42, role: 'user' })
  const core = {
    settings: {
      read: (keys: CoreSettingKey[]) =>
        Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
    },
    auth: { getSessionUser },
    yggdrasil: methods,
  } as unknown as Core
  const app = createApp({ core })
  const request = (method: string, url: string, headers = {}) =>
    app.request(`http://example.test${url}`, {
      method,
      headers: {
        origin: 'http://example.test',
        'content-type': 'application/json',
        cookie: 'session=placeholder',
        ...headers,
      },
    })
  return { app, request, methods, getSessionUser }
}

test.each(endpoints)('%s %s 只转交会话 uid，空 JSON DELETE 不要求请求体', async (method, url, status, fn, args) => {
  const { request, methods, getSessionUser } = setup()
  const response = await request(method, url)
  expect(response.status).toBe(status)
  if (method === 'GET') expect(await response.json()).toEqual({ tokens })
  else expect(await response.text()).toBe('')
  expect(methods[fn]).toHaveBeenCalledExactlyOnceWith(...args)
  expect(getSessionUser).toHaveBeenCalledWith(expect.any(Headers), 'http://example.test')
})

test.each(endpoints)('%s %s 无会话返回 401', async (method, url, _status, fn) => {
  const { request, methods, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  const response = await request(method, url)
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } })
  expect(methods[fn]).not.toHaveBeenCalled()
})

test.each(['0', '-1', '1.2', 'abc', '1e2', '9007199254740992', '12x'])('id %s 必须是安全的正整数', async (id) => {
  const { request, methods } = setup()
  const response = await request('DELETE', `${path}/${id}`)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { code: 'invalid_request', fields: { id: { code: 'invalid_value' } } },
  })
  expect(methods.revokeToken).not.toHaveBeenCalled()
})

test('不存在或非本人的 id 仍转交会话 uid，由用例幂等吊销；两个 DELETE 的简单请求检查 Origin', async () => {
  const { app, request, methods } = setup()
  expect((await request('DELETE', `${path}/999`)).status).toBe(204)
  expect(methods.revokeToken).toHaveBeenCalledWith(42, 999)
  for (const url of [path, `${path}/12`]) {
    expect((await app.request(`http://example.test${url}`, { method: 'DELETE' })).status).toBe(403)
    expect(
      (
        await request('DELETE', url, {
          origin: 'https://evil.test',
          'sec-fetch-site': 'same-origin',
          'content-type': 'text/plain',
        })
      ).status,
    ).toBe(403)
  }
})
