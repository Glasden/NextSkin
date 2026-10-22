import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { createTranslator, getMessages, locales, type Locale } from '@nextskin/i18n'
import { expect, test, vi, type Mock } from 'vitest'
import { createApp } from '../app.ts'

const methods = [
  'listFailedJobs',
  'retryFailedJob',
  'deleteFailedJob',
  'retryAllFailedJobs',
  'deleteAllFailedJobs',
] as const
type Method = (typeof methods)[number]
const actor = { uid: 42, ip: '192.0.2.10' }
const endpoints = [
  { method: 'GET', path: '/admin/failed-jobs?page=2', fn: 'listFailedJobs', args: [actor.uid, { page: 2 }] },
  { method: 'POST', path: '/admin/failed-jobs/7/retry', fn: 'retryFailedJob', args: [actor, 7] },
  { method: 'DELETE', path: '/admin/failed-jobs/7', fn: 'deleteFailedJob', args: [actor, 7] },
  {
    method: 'POST',
    path: '/admin/failed-jobs/retry',
    body: { through: 9 },
    fn: 'retryAllFailedJobs',
    args: [actor, 9],
  },
  { method: 'DELETE', path: '/admin/failed-jobs?through=9', fn: 'deleteAllFailedJobs', args: [actor, 9] },
] as const satisfies readonly { method: string; path: string; body?: unknown; fn: Method; args: readonly unknown[] }[]
const results: Record<Method, { resolved: unknown; response: unknown }> = {
  listFailedJobs: {
    resolved: { total: 0, latestId: null, items: [] },
    response: { total: 0, latestId: null, items: [] },
  },
  retryFailedJob: { resolved: undefined, response: { ok: true } },
  deleteFailedJob: { resolved: undefined, response: { ok: true } },
  retryAllFailedJobs: { resolved: { retried: 2, skipped: 1 }, response: { retried: 2, skipped: 1 } },
  deleteAllFailedJobs: { resolved: { deleted: 3 }, response: { deleted: 3 } },
}

function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi.fn().mockResolvedValue({
    uid: actor.uid,
    sessionId: 1,
    nickname: 'Admin',
    email: 'admin@example.test',
    role: 'superadmin',
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
          ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { peer: actor.ip },
    )
  return { app, request, admin, getSessionUser }
}
const body = (endpoint: (typeof endpoints)[number]) => ('body' in endpoint ? endpoint.body : undefined)

test.each(endpoints)('$method $path 调用 $fn，操作者来自会话和对端地址', async (endpoint) => {
  const { request, admin } = setup()
  admin[endpoint.fn].mockResolvedValue(results[endpoint.fn].resolved)
  const response = await request(endpoint.method, endpoint.path, body(endpoint))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(results[endpoint.fn].response)
  expect(admin[endpoint.fn]).toHaveBeenCalledExactlyOnceWith(...endpoint.args)
})

test('列表的页码默认是 1', async () => {
  const { request, admin } = setup()
  admin.listFailedJobs.mockResolvedValue(results.listFailedJobs.resolved)
  expect((await request('GET', '/admin/failed-jobs')).status).toBe(200)
  expect(admin.listFailedJobs).toHaveBeenCalledExactlyOnceWith(actor.uid, { page: 1 })
})

test.each(endpoints)('$method $path 没有会话返回 401，不调用用例', async (endpoint) => {
  const { request, admin, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request(endpoint.method, endpoint.path, body(endpoint))).status).toBe(401)
  for (const name of methods) expect(admin[name]).not.toHaveBeenCalled()
})

const invalid = [
  ...['0', '-1', '1.2', '1e2', '7x', '2147483648'].flatMap(
    (id) =>
      [
        [`重试的编号为 ${id}`, 'POST', `/admin/failed-jobs/${id}/retry`, undefined],
        [`删除的编号为 ${id}`, 'DELETE', `/admin/failed-jobs/${id}`, undefined],
        [`全部删除的 through 为 ${id}`, 'DELETE', `/admin/failed-jobs?through=${id}`, undefined],
      ] as const,
  ),
  ['全部删除缺少 through', 'DELETE', '/admin/failed-jobs', undefined],
  ['全部重试缺少请求体', 'POST', '/admin/failed-jobs/retry', undefined],
  ['全部重试的 through 不是整数', 'POST', '/admin/failed-jobs/retry', { through: 1.5 }],
  ['全部重试的 through 是字符串', 'POST', '/admin/failed-jobs/retry', { through: '9' }],
  ['全部重试的 through 为 0', 'POST', '/admin/failed-jobs/retry', { through: 0 }],
  ['全部重试的 through 超出 32 位', 'POST', '/admin/failed-jobs/retry', { through: 2147483648 }],
  ['页码为 0', 'GET', '/admin/failed-jobs?page=0', undefined],
  ['页码超出范围', 'GET', '/admin/failed-jobs?page=2147483648', undefined],
] as const

test.each(invalid)('%s：400 invalid_request，不调用用例', async (_name, method, path, payload) => {
  const { request, admin } = setup()
  const response = await request(method, path, payload)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  for (const name of methods) expect(admin[name]).not.toHaveBeenCalled()
})

function translate(locale: Locale, key: string): string {
  return (createTranslator(locale) as unknown as (key: string) => string)(key)
}
const failures = [
  ['permission_denied', 403, 'retryFailedJob'],
  ['dead_letter_not_found', 404, 'retryFailedJob'],
  ['dead_letter_not_retryable', 409, 'retryFailedJob'],
  ['dead_letter_not_found', 404, 'deleteFailedJob'],
  ['permission_denied', 403, 'listFailedJobs'],
  ['permission_denied', 403, 'retryAllFailedJobs'],
  ['permission_denied', 403, 'deleteAllFailedJobs'],
] as const

test.each(failures)('%s（%s）由 %s 抛出时映射状态码和文案', async (code, status, fn) => {
  const endpoint = endpoints.find((candidate) => candidate.fn === fn)!
  for (const locale of locales) {
    const { request, admin } = setup()
    admin[fn].mockRejectedValue(new DomainError(code))
    const response = await request(endpoint.method, endpoint.path, body(endpoint), { 'accept-language': locale })
    expect(response.status).toBe(status)
    const override: Record<string, string> = getMessages(locale).admin.errors
    expect(await response.json()).toMatchObject({
      error: {
        code,
        message: translate(locale, Object.hasOwn(override, code) ? `admin.errors.${code}` : `errors.${code}`),
      },
    })
  }
})

test('OpenAPI 声明列表、全部删除、全部重试和单条的重试、删除', async () => {
  const { app } = setup()
  const spec = (await (await app.request('http://example.test/api/openapi.json')).json()) as {
    paths: Record<string, object>
  }
  expect(Object.keys(spec.paths['/admin/failed-jobs']!).sort()).toEqual(['delete', 'get'])
  expect(Object.keys(spec.paths['/admin/failed-jobs/retry']!)).toEqual(['post'])
  expect(Object.keys(spec.paths['/admin/failed-jobs/{id}']!)).toEqual(['delete'])
  expect(Object.keys(spec.paths['/admin/failed-jobs/{id}/retry']!)).toEqual(['post'])
})
