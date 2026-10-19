import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { official, pluginEnvironment } from '../../../domain/src/plugins/plugins.test-helper.ts'
import { definePlugin, deny } from '../../../plugin-sdk/src/index.ts'
import { createApp } from '../app.ts'
import { errorSchema } from './errors.ts'

const env = pluginEnvironment()
const origin = 'https://skin.example.test'
const operations = [
  ['POST', '/enable', undefined],
  ['POST', '/disable', undefined],
  ['PATCH', '/settings', { values: { label: 'changed' } }],
  ['POST', '/dead-letters/1/retry', undefined],
  ['DELETE', '/dead-letters/1', undefined],
] as const
let app: ReturnType<typeof createApp>
let actor: Awaited<ReturnType<typeof env.actor>>
let session: Awaited<ReturnType<typeof env.core.auth.getSessionUser>>
let registration: 'allow' | 'deny' | 'throw'
const extras: unknown[] = []

beforeEach(async () => {
  registration = 'allow'
  extras.length = 0
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        settings: z.object({
          label: z
            .string()
            .refine((value) => value !== 'forbidden')
            .default('default-label'),
          count: z.number().int().positive().default(1),
        }),
        ui: {
          formFields: [
            {
              form: 'auth.register',
              field: { name: 'code', label: 'code', type: 'text', required: true, maxLength: 8 },
            },
          ],
        },
        intercept: {
          'user.register': ({ input }) => {
            extras.push(input.extra)
            if (registration === 'throw') throw new Error('interceptor failure')
            return Promise.resolve(registration === 'deny' ? deny('bad_code', '邀请码无效') : undefined)
          },
        },
        jobs: { fail: { maxAttempts: 1, handler: () => Promise.reject(new Error('job failure')) } },
        routes: {
          'POST /enqueue': {
            auth: 'public',
            handler: async ({ ctx }) => {
              await ctx.jobs.enqueue('fail', { message: 'retry me' })
              return new Response('queued')
            },
          },
        },
      }),
    ),
    official('b', definePlugin({ capabilities: [] })),
  ])
  actor = await env.actor()
  session = {
    uid: actor.uid,
    sessionId: 1,
    role: 'superadmin',
    nickname: 'Session',
    email: 'session@example.test',
    locale: null,
  }
  vi.spyOn(env.core.auth, 'getSessionUser').mockImplementation(() => Promise.resolve(session))
  app = createApp({ core: env.core })
})
afterEach(() => vi.restoreAllMocks())

function request(method: string, path: string, body?: unknown, originHeader: string | null = origin) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        host: 'skin.example.test',
        'x-forwarded-proto': 'https',
        cookie: 'session=example',
        ...(originHeader === null ? {} : { origin: originHeader }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { peer: '192.0.2.10' },
  )
}
async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  const result = errorSchema.parse(await response.json())
  expect(result.error.code).toBe(code)
  return result.error
}
const audits = () =>
  env.db.selectFrom('audit_logs').select(['action', 'actor_user_id', 'ip', 'details']).orderBy('id').execute()
async function enable() {
  await env.core.plugins.admin.enable(actor, 'a')
  await env.db.deleteFrom('audit_logs').execute()
}
async function failedJob() {
  await enable()
  expect((await request('POST', '/plugins/a/enqueue')).status).toBe(200)
  await env.core.jobs.drain()
  return env.db.selectFrom('failed_jobs').selectAll().executeTakeFirstOrThrow()
}
function register(plugins: unknown = { a: { code: 'INVITE' } }) {
  const { email, password, playerName } = env.input()
  return request('POST', '/api/register', { email, password, playerName, plugins })
}

test.each(operations)('后台 %s %s：管理员 403，未登录 401', async (method, path, body) => {
  const admin = await env.actor('admin')
  // 会话声明 superadmin，领域授权仍应从库里读取真实角色。
  session = { ...session!, uid: admin.uid }
  await failure(await request(method, `/api/admin/plugins/a${path}`, body), 403, 'permission_denied')
  session = null
  await failure(await request(method, `/api/admin/plugins/a${path}`, body), 401, 'unauthenticated')
  expect(await audits()).toEqual([])
})

test.each(operations)('后台 %s %s：未知插件返回 404', async (method, path, body) => {
  await failure(await request(method, `/api/admin/plugins/missing${path}`, body), 404, 'plugin_not_found')
  expect(await audits()).toEqual([])
})

// 跨站页面能发出的只有表单式的请求（没有 Content-Type 的按 text/plain 算）；JSON 请求要先过 CORS 预检，
// 发不出来，所以 REST 只对表单式的请求校验 Origin（hono/csrf，见 lib/api-client.ts）
const formLike = operations.filter(([, , body]) => body === undefined)

test.each(formLike)('后台 %s %s：缺失 Origin 必须拒绝', async (method, path, body) => {
  await failure(await request(method, `/api/admin/plugins/a${path}`, body, null), 403, 'invalid_origin')
  expect(await audits()).toEqual([])
})

test.each(formLike)('后台 %s %s：错误 Origin 必须拒绝', async (method, path, body) => {
  await failure(await request(method, `/api/admin/plugins/a${path}`, body, 'https://other.test'), 403, 'invalid_origin')
  expect(await audits()).toEqual([])
})

test('后台 PATCH /settings：跨站的表单请求被拒绝', async () => {
  const response = await app.request(
    `${origin}/api/admin/plugins/a/settings`,
    {
      method: 'PATCH',
      headers: {
        host: 'skin.example.test',
        'x-forwarded-proto': 'https',
        cookie: 'session=example',
        origin: 'https://other.test',
        'content-type': 'text/plain',
      },
      body: JSON.stringify({ values: { label: 'changed' } }),
    },
    { peer: '192.0.2.10' },
  )
  await failure(response, 403, 'invalid_origin')
  expect(await audits()).toEqual([])
})

test('超级管理员通过 REST 启用、停用插件，状态和审计一起改变', async () => {
  for (const [action, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    const response = await request('POST', `/api/admin/plugins/a/${action}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(env.core.plugins.isActive('a')).toBe(enabled)
    expect(
      await env.db.selectFrom('plugins').select('is_enabled').where('id', '=', 'a').executeTakeFirstOrThrow(),
    ).toEqual({ is_enabled: enabled ? 1 : 0 })
  }
  expect(
    (await audits()).map(({ action, actor_user_id, ip, details }) => ({
      action,
      actor_user_id,
      ip,
      details: JSON.parse(details) as unknown,
    })),
  ).toEqual([
    { action: 'plugin.enable', actor_user_id: actor.uid, ip: '192.0.2.10', details: { plugin: 'a', version: '1.0.0' } },
    {
      action: 'plugin.disable',
      actor_user_id: actor.uid,
      ip: '192.0.2.10',
      details: { plugin: 'a', version: '1.0.0' },
    },
  ])
})

test.each([
  [{ label: 42, count: 0 }, ['count', 'label']],
  [{ label: 'forbidden' }, ['label']],
] as const)('插件设置的 JSON Schema 和 refine 错误按设置键返回：%j', async (values, fields) => {
  const error = await failure(
    await request('PATCH', '/api/admin/plugins/a/settings', { values }),
    400,
    'invalid_request',
  )
  expect(Object.keys(error.fields!).sort()).toEqual(fields)
  for (const field of Object.values(error.fields!))
    expect(field).toEqual({ code: 'invalid_value', message: expect.any(String) as unknown })
  expect(await env.db.selectFrom('settings').select('key').where('namespace', '=', 'plugin:a').execute()).toEqual([])
  expect(await audits()).toEqual([])
})

test('超级管理员保存插件设置，返回更新的键并写审计', async () => {
  await env.core.plugins.admin.updateSettings(actor, 'a', { label: 'default-label' })
  await env.db.deleteFrom('audit_logs').execute()
  const response = await request('PATCH', '/api/admin/plugins/a/settings', { values: { label: 'changed' } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ updated: ['label'] })
  expect(
    await env.db.selectFrom('settings').select(['key', 'value']).where('namespace', '=', 'plugin:a').execute(),
  ).toEqual([{ key: 'label', value: '"changed"' }])
  const rows = await audits()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ action: 'plugin.settings', actor_user_id: actor.uid, ip: '192.0.2.10' })
  expect(JSON.parse(rows[0]!.details)).toEqual({ plugin: 'a', key: 'label', from: 'default-label', to: 'changed' })
})

test('重试死信返回队列并清零 attempts，删除死信不入队，两项都写审计', async () => {
  const dead = await failedJob()
  const retried = await request('POST', `/api/admin/plugins/a/dead-letters/${dead.id}/retry`)
  expect(retried.status).toBe(200)
  expect(await retried.json()).toEqual({ ok: true })
  expect(await env.db.selectFrom('failed_jobs').select('id').execute()).toEqual([])
  expect(await env.db.selectFrom('jobs').select(['name', 'attempts', 'payload']).execute()).toEqual([
    { name: 'plugin:a:job:fail', attempts: 0, payload: dead.payload },
  ])
  await env.core.jobs.drain()
  const again = await env.db.selectFrom('failed_jobs').select('id').executeTakeFirstOrThrow()
  const deleted = await request('DELETE', `/api/admin/plugins/a/dead-letters/${again.id}`)
  expect(deleted.status).toBe(200)
  expect(await deleted.json()).toEqual({ ok: true })
  expect(await env.db.selectFrom('failed_jobs').select('id').execute()).toEqual([])
  expect(await env.db.selectFrom('jobs').select('id').execute()).toEqual([])
  const rows = await audits()
  expect(rows).toHaveLength(2)
  for (const row of rows)
    expect(row).toMatchObject({ action: 'plugin.deadLetter', actor_user_id: actor.uid, ip: '192.0.2.10' })
  expect(rows.map((row) => JSON.parse(row.details) as unknown)).toEqual([
    { plugin: 'a', job: dead.id, action: 'retry' },
    { plugin: 'a', job: again.id, action: 'delete' },
  ])
})

test.each(['retry', 'delete'] as const)('死信 %s 不得操作别的插件或不存在的任务', async (action) => {
  const dead = await failedJob()
  for (const [id, job] of [
    ['b', dead.id],
    ['a', dead.id + 1000],
  ] as const) {
    const path = `/api/admin/plugins/${id}/dead-letters/${job}${action === 'retry' ? '/retry' : ''}`
    await failure(await request(action === 'retry' ? 'POST' : 'DELETE', path), 404, 'dead_letter_not_found')
  }
  expect(await env.db.selectFrom('failed_jobs').select('id').execute()).toEqual([{ id: dead.id }])
  expect(await audits()).toEqual([])
})

test.each(['0', '-1', '1.2', '1e2', '9007199254740992', '7x'])('拒绝非法死信 id：%s', async (job) => {
  await failure(await request('POST', `/api/admin/plugins/a/dead-letters/${job}/retry`), 400, 'invalid_request')
  await failure(await request('DELETE', `/api/admin/plugins/a/dead-letters/${job}`), 400, 'invalid_request')
})

test('注册 plugins 字段传给真实拦截器，放行后创建用户与会话', async () => {
  await enable()
  const createSession = vi.spyOn(env.core.auth, 'createSession').mockResolvedValue(['session=registered; HttpOnly'])
  const response = await register({ a: { code: ' INVITE ' } })
  expect(response.status).toBe(201)
  const result = (await response.json()) as { uid: number; signedIn: boolean }
  expect(result.signedIn).toBe(true)
  expect(await env.db.selectFrom('users').select('id').where('id', '=', result.uid).executeTakeFirstOrThrow()).toEqual({
    id: result.uid,
  })
  expect(extras).toEqual([{ code: 'INVITE' }])
  expect(createSession).toHaveBeenCalledOnce()
  expect(response.headers.getSetCookie()).toEqual(['session=registered; HttpOnly'])
})

test('插件拒绝注册：403 保留文案、plugin 和 deny code，且不建用户或会话', async () => {
  await enable()
  registration = 'deny'
  const createSession = vi.spyOn(env.core.auth, 'createSession')
  const response = await register()
  const error = await failure(response, 403, 'registration_denied')
  expect(error).toEqual({ code: 'registration_denied', message: '邀请码无效', plugin: 'a', reason: 'bad_code' })
  expect(extras).toEqual([{ code: 'INVITE' }])
  expect(await env.db.selectFrom('users').select('id').execute()).toEqual([{ id: actor.uid }])
  expect(await env.db.selectFrom('players').select('id').execute()).toEqual([])
  expect(createSession).not.toHaveBeenCalled()
})

test.each([undefined, {}, { a: { code: '' } }, { a: { code: '123456789' } }, { a: { code: false } }])(
  '注册插件字段不合法：400，字段键是 a.code：%j',
  async (plugins) => {
    await enable()
    const createSession = vi.spyOn(env.core.auth, 'createSession')
    // 显式构造无 plugins 的请求，避免 register() 的默认参数补上合法字段。
    const { email, password, playerName } = env.input()
    const error = await failure(
      await request('POST', '/api/register', { email, password, playerName, plugins }),
      400,
      'invalid_request',
    )
    expect(error.fields).toEqual({ 'a.code': { code: 'invalid_value', message: expect.any(String) as unknown } })
    expect(extras).toEqual([])
    expect(createSession).not.toHaveBeenCalled()
    expect(await env.db.selectFrom('users').select('id').execute()).toEqual([{ id: actor.uid }])
  },
)

test.each([{ a: 'invalid' }, []])('注册拒绝不合法的 plugins 结构：%j', async (plugins) => {
  await enable()
  const error = await failure(await register(plugins), 400, 'invalid_request')
  expect(Object.keys(error.fields!)).toEqual(['plugins'])
  expect(extras).toEqual([])
})

test('注册拦截器抛错：503 plugin_unavailable，不创建用户和会话', async () => {
  await enable()
  registration = 'throw'
  const createSession = vi.spyOn(env.core.auth, 'createSession')
  await failure(await register(), 503, 'plugin_unavailable')
  expect(extras).toEqual([{ code: 'INVITE' }])
  expect(await env.db.selectFrom('users').select('id').execute()).toEqual([{ id: actor.uid }])
  expect(await env.db.selectFrom('players').select('id').execute()).toEqual([])
  expect(createSession).not.toHaveBeenCalled()
})
