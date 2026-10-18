import { DomainError } from '@nextskin/domain'
import { beforeEach, expect, test, vi } from 'vitest'
import { setup as setupDomain } from '../../../domain/src/closet/test-support.ts'
import { createApp } from '../app.ts'

const env = setupDomain()
let authenticated = true
let sessionUid: number
beforeEach(async () => {
  await env.db().deleteFrom('audit_logs').execute()
  authenticated = true
  sessionUid = env.actor.uid
  vi.spyOn(env.core.auth, 'getSessionUser').mockImplementation(() =>
    Promise.resolve(
      authenticated
        ? {
            uid: sessionUid,
            nickname: 'Session',
            email: 'session@example.test',
            emailVerified: true,
            // 会话故意是过时的角色，领域层必须重新查库。
            role: 'superadmin',
            locale: null,
          }
        : null,
    ),
  )
})
function setup(peer: string | null = '192.0.2.10') {
  const app = createApp({ core: env.core })
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
      { peer },
    )
  return { app, request }
}
async function admin() {
  await env.db().updateTable('users').set({ role: 'admin' }).where('id', '=', env.actor.uid).execute()
}
async function report() {
  return env.core.reports.create(env.owner, { tid: await env.texture(), reason: 'Reason' })
}

test('遍历所有已注册后台路由：普通用户一律 403，未登录一律 401', async () => {
  const { app, request } = setup()
  const routes = [
    ...new Map(
      app.routes
        .filter((r) => r.path.startsWith('/api/admin/') && r.method !== 'ALL' && !r.path.includes('*'))
        .map((r) => [`${r.method} ${r.path}`, r]),
    ).values(),
  ]
  expect(routes).toHaveLength(3)
  for (const route of routes) {
    const path = route.path.slice('/api'.length).replace(/:(?:id|tid|uid)/g, '7')
    const body =
      route.method === 'POST' ? { action: 'dismiss' } : route.method === 'PATCH' ? { role: 'banned' } : undefined
    for (const loggedIn of [true, false]) {
      authenticated = loggedIn
      const response = await request(route.method, path, body)
      expect(response.status).toBe(loggedIn ? 403 : 401)
      expect(await response.json()).toMatchObject({
        error: { code: loggedIn ? 'permission_denied' : 'unauthenticated' },
      })
    }
  }
})

test('处理举报成功返回后台视图，IP 经过可信代理解析后写审计', async () => {
  const created = await report()
  await admin()
  await env.setting('network.trustedProxies', ['192.0.2.10'])
  const { request } = setup()
  const response = await request(
    'POST',
    `/admin/reports/${created.id}/resolve`,
    { action: 'dismiss', uid: env.owner.uid },
    { 'x-forwarded-for': '198.51.100.20' },
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    id: created.id,
    status: 'rejected',
    resolution: 'dismissed',
    scorePaid: 0,
    texture: { tid: created.tid, public: true },
    resolver: { uid: env.actor.uid },
    reporter: { uid: env.owner.uid },
  })
  expect(await env.db().selectFrom('audit_logs').select(['actor_user_id', 'ip']).execute()).toEqual([
    { actor_user_id: env.actor.uid, ip: '198.51.100.20' },
  ])
})

test('管理员删除成功并结案举报；不可信 XFF 不写进审计', async () => {
  const created = await report()
  await admin()
  const { request } = setup()
  const response = await request('DELETE', `/admin/textures/${created.tid}`, undefined, {
    'x-forwarded-for': '198.51.100.20',
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ resolvedReports: 1 })
  const audit = await env.db().selectFrom('audit_logs').select(['action', 'ip']).execute()
  expect(audit.slice(-2)).toEqual([
    { action: 'report.resolve', ip: '192.0.2.10' },
    { action: 'texture.delete', ip: '192.0.2.10' },
  ])
})

test('改角色返回后台用户视图，IP 没有对端地址时为空', async () => {
  await admin()
  const { request } = setup(null)
  const response = await request('PATCH', `/admin/users/${env.owner.uid}`, { role: 'banned' })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    uid: env.owner.uid,
    nickname: 'owner',
    email: 'owner@example.test',
    emailVerified: true,
    role: 'banned',
    score: 1000,
    registeredAt: '2020-01-01T00:00:00.000Z',
    avatar: null,
  })
  expect(await env.db().selectFrom('audit_logs').select('ip').orderBy('id', 'desc').limit(1).execute()).toEqual([
    { ip: null },
  ])
})

test.each([
  ['permission_denied', 403, 'setRole', 'PATCH', '/admin/users/7', { role: 'admin' }],
  ['user_not_manageable', 403, 'setRole', 'PATCH', '/admin/users/7', { role: 'banned' }],
  ['user_not_found', 404, 'setRole', 'PATCH', '/admin/users/7', { role: 'banned' }],
  ['report_not_found', 404, 'resolveReport', 'POST', '/admin/reports/7/resolve', { action: 'dismiss' }],
  ['report_already_handled', 409, 'resolveReport', 'POST', '/admin/reports/7/resolve', { action: 'dismiss' }],
  ['texture_not_found', 404, 'deleteTexture', 'DELETE', '/admin/textures/7', undefined],
] as const)('%s 映射到 %s 并本地化', async (code, status, method, verb, path, body) => {
  vi.spyOn(env.core.admin, method).mockRejectedValue(new DomainError(code))
  const response = await setup().request(verb, path, body, { 'accept-language': 'en' })
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code, message: expect.stringMatching(/[a-z]/i) as unknown } })
})

test('真实用例的错误状态与再次处理冲突', async () => {
  const created = await report()
  await admin()
  const { request } = setup()
  expect((await request('PATCH', `/admin/users/${env.actor.uid}`, { role: 'user' })).status).toBe(403)
  expect((await request('PATCH', '/admin/users/2147483647', { role: 'user' })).status).toBe(404)
  expect((await request('POST', '/admin/reports/2147483647/resolve', { action: 'dismiss' })).status).toBe(404)
  expect((await request('DELETE', '/admin/textures/2147483647')).status).toBe(404)
  expect((await request('POST', `/admin/reports/${created.id}/resolve`, { action: 'dismiss' })).status).toBe(200)
  const response = await request('POST', `/admin/reports/${created.id}/resolve`, { action: 'deleteTexture' })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'report_already_handled' } })
})

test('参数校验、CSRF、JSON 类型和请求体上限；OpenAPI 声明三个接口', async () => {
  await admin()
  const { request, app } = setup()
  for (const value of ['0', '-1', '1.2', '1e2', '2147483648', '7x']) {
    expect((await request('DELETE', `/admin/textures/${value}`)).status).toBe(400)
    expect((await request('POST', `/admin/reports/${value}/resolve`, { action: 'dismiss' })).status).toBe(400)
    expect((await request('PATCH', `/admin/users/${value}`, { role: 'banned' })).status).toBe(400)
  }
  expect((await request('PATCH', '/admin/users/7', { role: 'superadmin' })).status).toBe(400)
  expect((await request('POST', '/admin/reports/7/resolve', { action: 'other' })).status).toBe(400)
  expect(
    (
      await request(
        'POST',
        '/admin/reports/7/resolve',
        { action: 'dismiss' },
        { origin: 'https://other.test', 'content-type': 'text/plain' },
      )
    ).status,
  ).toBe(403)
  expect(
    (await request('POST', '/admin/reports/7/resolve', { action: 'dismiss' }, { 'content-type': 'text/plain' })).status,
  ).toBe(415)
  expect(
    (await request('POST', '/admin/reports/7/resolve', { action: 'dismiss', extra: 'a'.repeat(17 * 1024) })).status,
  ).toBe(413)
  const spec = (await (await app.request('http://example.test/api/openapi.json')).json()) as {
    paths: Record<string, unknown>
  }
  for (const path of ['/admin/reports/{id}/resolve', '/admin/textures/{tid}', '/admin/users/{uid}'])
    expect(spec.paths[path]).toBeDefined()
})
