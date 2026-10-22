import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { LOCALE_COOKIE } from '@nextskin/i18n'
import { expect, test, vi, type Mock } from 'vitest'
import { createApp } from '../app.ts'

const uid = 42
const actor = { uid, ip: '192.0.2.10' }
const methods = [
  'summary',
  'list',
  'markRead',
  'markAllRead',
  'remove',
  'sendNotification',
  'listNotificationBroadcasts',
  'recallNotification',
] as const
type Method = (typeof methods)[number]
const input = { audience: 'specific', recipients: ['1'], title: '标题', body: '**正文**' }
const endpoints = [
  {
    method: 'GET',
    path: '/notifications/summary',
    fn: 'summary',
    args: [uid, 'zh-CN'],
    result: { unread: 0, latest: [] },
  },
  {
    method: 'GET',
    path: '/notifications?filter=unread&page=2',
    fn: 'list',
    args: [uid, 'zh-CN', { filter: 'unread', page: 2 }],
    result: { total: 0, unread: 0, latestId: null, items: [] },
  },
  { method: 'POST', path: '/notifications/7/read', fn: 'markRead', args: [uid, 7] },
  {
    method: 'POST',
    path: '/notifications/read-all',
    fn: 'markAllRead',
    args: [uid, 9],
    body: { through: 9 },
    result: 3,
  },
  { method: 'DELETE', path: '/notifications/7', fn: 'remove', args: [uid, 7] },
  {
    method: 'GET',
    path: '/admin/notifications?page=2',
    fn: 'listNotificationBroadcasts',
    args: [actor, { page: 2 }],
    result: { total: 0, items: [] },
  },
  {
    method: 'POST',
    path: '/admin/notifications',
    fn: 'sendNotification',
    args: [actor, input],
    body: input,
    result: { id: 3 },
  },
  { method: 'POST', path: '/admin/notifications/7/recall', fn: 'recallNotification', args: [actor, 7] },
] as const satisfies readonly {
  method: string
  path: string
  fn: Method
  args: unknown[]
  body?: unknown
  result?: unknown
}[]
function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi.fn().mockResolvedValue({
    uid,
    sessionId: 1,
    nickname: 'Admin',
    email: 'admin@example.test',
    role: 'admin',
    locale: null,
  })
  const calls = Object.fromEntries(methods.map((method) => [method, vi.fn()])) as Record<Method, Mock>
  const core = { settings: { read }, auth: { getSessionUser }, notifications: calls, admin: calls } as unknown as Core
  const app = createApp({ core })
  function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(
      `http://example.test/api${path}`,
      {
        method,
        headers: {
          origin: 'http://example.test',
          ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { peer: actor.ip },
    )
  }
  return { calls, request, getSessionUser }
}
const payload = (endpoint: (typeof endpoints)[number]) => ('body' in endpoint ? endpoint.body : undefined)

test.each(endpoints)('$method $path 只把会话 uid、对端 IP 和通过校验的参数交给领域用例', async (endpoint) => {
  const { calls, request, getSessionUser } = setup()
  const result = 'result' in endpoint ? endpoint.result : undefined
  calls[endpoint.fn].mockResolvedValue(result)
  const response = await request(endpoint.method, endpoint.path, payload(endpoint))
  expect(response.status).toBe(endpoint.fn === 'sendNotification' ? 201 : 200)
  expect(await response.json()).toEqual(endpoint.fn === 'markAllRead' ? { marked: 3 } : (result ?? { ok: true }))
  expect(calls[endpoint.fn]).toHaveBeenCalledExactlyOnceWith(...endpoint.args)
  expect(getSessionUser).toHaveBeenCalledTimes(1)
})

test.each(endpoints)('$method $path 无会话 401', async (endpoint) => {
  const { calls, request, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request(endpoint.method, endpoint.path, payload(endpoint))).status).toBe(401)
  for (const method of methods) expect(calls[method]).not.toHaveBeenCalled()
})

test.each(['summary', 'list', 'markRead', 'markAllRead', 'remove'] as const)(
  '用户中心的 %s 保留领域层 user_banned 403',
  async (fn) => {
    const { calls, request } = setup()
    calls[fn].mockRejectedValue(new DomainError('user_banned'))
    const endpoint = endpoints.find((endpoint) => endpoint.fn === fn)!
    const response = await request(endpoint.method, endpoint.path, payload(endpoint))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'user_banned' } })
  },
)

test.each(['sendNotification', 'listNotificationBroadcasts', 'recallNotification'] as const)(
  '后台 %s 的权限错误返回 403',
  async (fn) => {
    const { calls, request } = setup()
    calls[fn].mockRejectedValue(new DomainError('permission_denied'))
    const endpoint = endpoints.find((endpoint) => endpoint.fn === fn)!
    expect((await request(endpoint.method, endpoint.path, payload(endpoint))).status).toBe(403)
  },
)

test('默认分页和筛选', async () => {
  const { calls, request } = setup()
  calls.list.mockResolvedValue({ total: 0, unread: 0, latestId: null, items: [] })
  calls.listNotificationBroadcasts.mockResolvedValue({ total: 0, items: [] })
  await request('GET', '/notifications')
  await request('GET', '/admin/notifications')
  expect(calls.list).toHaveBeenCalledExactlyOnceWith(uid, 'zh-CN', { filter: 'all', page: 1 })
  expect(calls.listNotificationBroadcasts).toHaveBeenCalledExactlyOnceWith(actor, { page: 1 })
})

test('语言按用户、Cookie、Accept-Language、站点默认排序', async () => {
  const { calls, request, getSessionUser } = setup()
  calls.summary.mockResolvedValue({ unread: 0, latest: [] })
  getSessionUser.mockResolvedValue({ uid, role: 'user', locale: 'en' })
  await request('GET', '/notifications/summary', undefined, {
    cookie: `${LOCALE_COOKIE}=zh-CN`,
    'accept-language': 'zh-CN',
  })
  expect(calls.summary).toHaveBeenLastCalledWith(uid, 'en')
  getSessionUser.mockResolvedValue({ uid, role: 'user', locale: null })
  await request('GET', '/notifications/summary', undefined, {
    cookie: `${LOCALE_COOKIE}=en`,
    'accept-language': 'zh-CN',
  })
  expect(calls.summary).toHaveBeenLastCalledWith(uid, 'en')
  await request('GET', '/notifications/summary', undefined, { 'accept-language': 'en' })
  expect(calls.summary).toHaveBeenLastCalledWith(uid, 'en')
  await request('GET', '/notifications/summary')
  expect(calls.summary).toHaveBeenLastCalledWith(uid, 'zh-CN')
})

const invalid = [
  ...['0', '-1', '1.5', '1e2', '2147483648', '7x'].flatMap(
    (id) =>
      [
        ['POST', `/notifications/${id}/read`, undefined],
        ['DELETE', `/notifications/${id}`, undefined],
        ['POST', `/admin/notifications/${id}/recall`, undefined],
        ['GET', `/notifications?page=${id}`, undefined],
        ['GET', `/admin/notifications?page=${id}`, undefined],
      ] as const,
  ),
  ['GET', '/notifications?filter=read', undefined],
  ['POST', '/notifications/read-all', undefined],
  ...[0, -1, 1.5, '7', 2147483648].map((through) => ['POST', '/notifications/read-all', { through }] as const),
  ['POST', '/admin/notifications', {}],
  ['POST', '/admin/notifications', { ...input, audience: 'invalid' }],
  ['POST', '/admin/notifications', { ...input, recipients: [] }],
  ['POST', '/admin/notifications', { ...input, recipients: [7] }],
  ['POST', '/admin/notifications', { ...input, recipients: Array(51).fill('7') }],
] as const

test.each(invalid)('%s %s 参数非法返回 400，不调用用例', async (method, path, body) => {
  const { calls, request } = setup()
  const response = await request(method, path, body)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  for (const method of methods) expect(calls[method]).not.toHaveBeenCalled()
})

test.each([
  ['POST', '/notifications/7/read', 'markRead', 'notification_not_found', 404],
  ['DELETE', '/notifications/7', 'remove', 'notification_not_found', 404],
  ['POST', '/admin/notifications/7/recall', 'recallNotification', 'notification_broadcast_not_found', 404],
  ['POST', '/admin/notifications/7/recall', 'recallNotification', 'notification_broadcast_recalled', 409],
] as const)('%s %s 的 %s 错误码和状态', async (method, path, fn, code, status) => {
  const { calls, request } = setup()
  calls[fn].mockRejectedValue(new DomainError(code))
  const response = await request(method, path)
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code } })
})

test('指定收件人错误带字段和未知值，两种语言都能渲染', async () => {
  const { calls, request } = setup()
  calls.sendNotification.mockRejectedValue(
    new DomainError('notification_recipient_unknown', { value: 'missing@example.test' }, ['recipients']),
  )
  for (const locale of ['zh-CN', 'en']) {
    const response = await request('POST', '/admin/notifications', input, { 'accept-language': locale })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string; fields: unknown } }
    expect(body.error.message).toContain('missing@example.test')
    expect(body.error.fields).toMatchObject({ recipients: { code: 'notification_recipient_unknown' } })
  }
})

test('5000 个四字节码位的正文可通过请求体大小限制', async () => {
  const { calls, request } = setup()
  calls.sendNotification.mockResolvedValue({ id: 1 })
  expect((await request('POST', '/admin/notifications', { ...input, body: '😀'.repeat(5000) })).status).toBe(201)
})
