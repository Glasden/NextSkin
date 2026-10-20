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
            sessionId: 1,
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
          ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
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
  expect(routes).toHaveLength(36)
  for (const route of routes) {
    const path = route.path
      .slice('/api'.length)
      .replace(/^\/admin\/plugins\/:id/, '/admin/plugins/missing')
      .replace(/:(?:id|tid|uid|pid|job)/g, '7')
      .replace(':key', 'yggdrasil.signingKey')
      .replace(':pluginId', 'missing')
      .replace(':providerId', 'missing')
    // 两个读接口的查询参数是必填的
    const query =
      path === '/admin/users/lookup'
        ? '?q=7'
        : route.method === 'GET' && path.startsWith('/admin/textures/')
          ? '?owner=8'
          : ''
    // 上传插件包的接口只收 multipart：先检查内容类型，再检查权限
    const upload = new FormData()
    upload.set('file', new Blob([new Uint8Array([1])]), 'plugin.tgz')
    upload.set('packageHash', '0'.repeat(64))
    // 请求体要能通过 zod 和用例在查权限之前做的格式检查，才会走到权限检查
    const body = route.path.startsWith('/api/admin/plugin-packages')
      ? upload
      : route.path.endsWith('/settings')
        ? { values: {} }
        : route.path.endsWith('/email')
          ? { email: 'new@example.test' }
          : route.path.endsWith('/password')
            ? { password: 'new-password-123' }
            : route.path.endsWith('/score')
              ? { delta: 1 }
              : route.path.endsWith('/transfer')
                ? { uid: 8 }
                : route.path.endsWith('/closet') && route.method === 'POST'
                  ? { tid: 7 }
                  : route.path.startsWith('/api/admin/textures/') && route.method === 'PATCH'
                    ? { name: 'Skin' }
                    : route.path.startsWith('/api/admin/players/') && route.method === 'PATCH'
                      ? { name: 'Steve' }
                      : route.method === 'POST'
                        ? { action: 'dismiss' }
                        : route.method === 'PATCH'
                          ? { role: 'banned' }
                          : undefined
    for (const loggedIn of [true, false]) {
      authenticated = loggedIn
      const response = await request(route.method, path + query, body)
      expect(response.status, `${route.method} ${path}`).toBe(loggedIn ? 403 : 401)
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

test('改身份返回后台用户视图，IP 没有对端地址时为空', async () => {
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
  ['permission_denied', 403, 'updateUser', 'PATCH', '/admin/users/7', { role: 'admin' }],
  ['user_not_manageable', 403, 'updateUser', 'PATCH', '/admin/users/7', { role: 'banned' }],
  ['user_not_found', 404, 'updateUser', 'PATCH', '/admin/users/7', { role: 'banned' }],
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

test('参数校验、CSRF、JSON 类型和请求体上限；OpenAPI 声明这些接口', async () => {
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
  for (const path of [
    '/admin/reports/{id}/resolve',
    '/admin/textures/{tid}',
    '/admin/textures/{tid}/unpublish',
    '/admin/users/{uid}/closet',
    '/admin/users/{uid}/closet/{tid}',
    '/admin/users/{uid}',
    '/admin/settings',
    '/admin/settings/{key}/generate',
    '/admin/settings/mail/test',
    '/admin/users/{uid}/email',
    '/admin/users/{uid}/password',
    '/admin/users/{uid}/two-factor',
    '/admin/users/{uid}/passkeys',
    '/admin/users/{uid}/bindings/{pluginId}/{providerId}',
    '/admin/users/{uid}/sessions',
    '/admin/users/{uid}/score',
    '/admin/users/lookup',
    '/admin/players/{pid}',
    '/admin/players/{pid}/transfer',
  ])
    expect(spec.paths[path]).toBeDefined()
  // 改用户和删除用户共用一个路径
  expect(Object.keys(spec.paths['/admin/users/{uid}'] as object).sort()).toEqual(['delete', 'patch'])
})

test('管理员没有 settings.manage，三个设置接口都返回 403', async () => {
  await admin()
  for (const [method, path, body] of [
    ['PATCH', '/admin/settings', { values: {} }],
    ['POST', '/admin/settings/yggdrasil.signingKey/generate', undefined],
    ['POST', '/admin/settings/mail/test', undefined],
  ] as const) {
    const response = await setup().request(method, path, body)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'permission_denied' } })
  }
})

test('超级管理员保存设置：字段错误以设置键为名，整批拒绝；未知和内部项不带字段', async () => {
  await env.db().updateTable('users').set({ role: 'superadmin' }).where('id', '=', env.actor.uid).execute()
  const { request } = setup()
  const response = await request('PATCH', '/admin/settings', {
    values: { 'site.name': 'Not saved', 'player.nameRegex': '[', 'site.url': 'bad' },
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: {
      code: 'invalid_request',
      fields: {
        'site.url': { code: 'invalid_value', message: expect.any(String) as unknown },
        'player.nameRegex': { code: 'invalid_value', message: expect.any(String) as unknown },
      },
    },
  })
  expect((await env.core.settings.read(['site.name']))['site.name']).toBe('NextSkin')
  for (const key of ['missing', 'auth.legacyPasswordSalt']) {
    const invalid = await request('PATCH', '/admin/settings', { values: { [key]: '' } })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: { code: 'invalid_request', message: expect.any(String) as unknown } })
  }
  const saved = await request('PATCH', '/admin/settings', { values: { 'site.name': 'New name' } })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toEqual({ updated: ['site.name'] })
  // 公告和内容政策各 20000 个字，超出其他接口 16 KiB 的请求体上限
  const longest = { 'site.announcement': '𝓐'.repeat(20000), 'texture.contentPolicy': '𝓐'.repeat(20000) }
  const markdown = await request('PATCH', '/admin/settings', { values: longest })
  expect(markdown.status).toBe(200)
  expect(await markdown.json()).toEqual({ updated: ['site.announcement', 'texture.contentPolicy'] })
  const tooLarge = await request('PATCH', '/admin/settings', { values: { 'site.name': 'a'.repeat(200 * 1024) } })
  expect(tooLarge.status).toBe(413)
})

test('生成接口不回传私钥；测试邮件返回收件人；邮件失败为 502 且 message 带 reason', async () => {
  const generate = vi.spyOn(env.core.admin, 'generateSetting').mockResolvedValue({ updated: ['yggdrasil.signingKey'] })
  const { request } = setup()
  const generated = await request('POST', '/admin/settings/yggdrasil.signingKey/generate')
  expect(generated.status).toBe(200)
  expect(await generated.json()).toEqual({ updated: ['yggdrasil.signingKey'] })
  expect(generate).toHaveBeenCalledWith({ uid: env.actor.uid, ip: '192.0.2.10' }, 'yggdrasil.signingKey')
  const send = vi.spyOn(env.core.admin, 'sendTestMail').mockResolvedValue({ to: 'actor@example.test' })
  const sent = await request('POST', '/admin/settings/mail/test')
  expect(sent.status).toBe(200)
  expect(await sent.json()).toEqual({ to: 'actor@example.test' })
  send.mockRejectedValue(new DomainError('mail_test_failed', { reason: '535 SMTP rejected' }))
  const failed = await request('POST', '/admin/settings/mail/test', undefined, { 'accept-language': 'en' })
  expect(failed.status).toBe(502)
  expect(await failed.json()).toMatchObject({
    error: { code: 'mail_test_failed', message: expect.stringContaining('535 SMTP rejected') as unknown },
  })
  send.mockRejectedValue(new DomainError('mail_not_configured'))
  const missing = await request('POST', '/admin/settings/mail/test')
  expect(missing.status).toBe(400)
  expect(await missing.json()).toMatchObject({ error: { code: 'mail_not_configured' } })
})
