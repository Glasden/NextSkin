import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

const endpoints = [
  ['approve', 'approveDevice', { userCode: 'ABCDEFGH', pid: 3 }],
  ['deny', 'denyDevice', { userCode: 'ABCDEFGH' }],
] as const
function setup() {
  const methods = {
    approveDevice: vi.fn().mockResolvedValue(undefined),
    denyDevice: vi.fn().mockResolvedValue(undefined),
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
  const request = (action: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://example.test/api/user/device/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        origin: 'http://example.test',
        'content-type': 'application/json',
        cookie: 'session=placeholder',
        ...headers,
      },
    })
  return { request, methods, getSessionUser }
}

test.each(endpoints)('%s 只转交会话 uid 和校验后的输入', async (action, method, input) => {
  const { request, methods } = setup()
  expect((await request(action, { ...input, uid: 99 })).status).toBe(204)
  expect(methods[method]).toHaveBeenCalledExactlyOnceWith(42, input)
})

test.each(endpoints)('%s 无会话返回 401', async (action, method, input) => {
  const { request, methods, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request(action, input)).status).toBe(401)
  expect(methods[method]).not.toHaveBeenCalled()
})

test.each(endpoints)('%s 非法输入返回 400', async (action, method, input) => {
  const { request, methods } = setup()
  for (const userCode of ['', 'A'.repeat(65), null, 42])
    expect((await request(action, { ...input, userCode })).status).toBe(400)
  if (action === 'approve') {
    for (const pid of [0, -1, 1.2, '3', 9007199254740992, undefined])
      expect((await request(action, { ...input, pid })).status).toBe(400)
    expect((await request(action, { ...input, pid: null })).status).toBe(204)
    methods[method].mockClear()
  }
  expect(methods[method]).not.toHaveBeenCalled()
})

test.each(endpoints)('%s 跨站和缺 Content-Type 返回 403/415', async (action, method, input) => {
  const { request, methods } = setup()
  expect(
    (
      await request(action, input, {
        origin: 'https://evil.test',
        'sec-fetch-site': 'same-origin',
        'content-type': 'text/plain',
      })
    ).status,
  ).toBe(403)
  expect((await request(action, input, { 'content-type': '' })).status).toBe(415)
  expect(methods[method]).not.toHaveBeenCalled()
})

test.each([
  ['device_code_invalid', 400],
  ['device_code_expired', 400],
  ['device_code_claimed', 403],
  ['device_code_processed', 409],
  ['device_player_required', 400],
  ['oauth_scope_invalid', 400],
  ['player_not_found', 404],
  ['user_banned', 403],
  ['email_not_verified', 403],
  ['too_many_requests', 429],
] as const)('%s 映射到 %i', async (code, status) => {
  const { request, methods } = setup()
  methods.approveDevice.mockRejectedValue(
    new DomainError(code, code === 'too_many_requests' ? { retryAfter: 600 } : undefined),
  )
  const response = await request('approve', { userCode: 'ABCDEFGH', pid: 3 })
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code } })
  if (code === 'too_many_requests') expect(response.headers.get('retry-after')).toBe('600')
})
