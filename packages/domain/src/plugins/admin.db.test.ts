import { countRows } from '@nextskin/db'
import { definePlugin, secret, table, type Json } from '@nextskin/plugin-sdk'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { official, pluginEnvironment } from './plugins.test-helper.ts'

const env = pluginEnvironment()
const empty = () => definePlugin({ capabilities: [] })
const route = (path: string) =>
  env.core.plugins.route({
    pluginId: 'a',
    method: 'POST',
    path,
    user: null,
    locale: 'en',
    ip: '192.0.2.1',
    request: { method: 'POST', url: `https://skin.example.test/plugins/a${path}`, headers: [], body: null },
  })
const audits = () => env.db.selectFrom('audit_logs').selectAll().where('action', 'like', 'plugin.%').execute()

test('superadmin 启用：按键排序迁移一次，物理表有前缀，记录迁移和审计', async () => {
  const order: string[] = []
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: ['storage.tables'],
        tables: { records: table<{ value: string }>() },
        migrations: {
          '002': {
            up: async (db) => {
              order.push('002')
              await db.insertInto('records').values({ value: 'seed' }).execute()
            },
          },
          '001': {
            up: async (db) => {
              order.push('001')
              // eslint-disable-next-line nextskin/no-dialect-specific-sql -- 插件迁移使用远程 Kysely，由网关处理方言。
              await db.schema.createTable('records').addColumn('value', 'varchar(128)').execute()
            },
          },
        },
      }),
    ),
  ])
  const actor = await env.actor()
  await env.core.plugins.admin.enable(actor, 'a')
  await env.core.plugins.admin.enable(actor, 'a')
  expect(order).toEqual(['001', '002'])
  expect(
    (await env.db.selectFrom('plugin_migrations').select(['plugin_id', 'name']).execute()).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  ).toEqual([
    { plugin_id: 'a', name: '001' },
    { plugin_id: 'a', name: '002' },
  ])
  expect((await env.db.introspection.getTables()).map((t) => t.name)).toContain('p_a__records')
  expect(
    await env.db.withTables<{ p_a__records: { value: string } }>().selectFrom('p_a__records').selectAll().execute(),
  ).toEqual([{ value: 'seed' }])
  expect(env.core.plugins.isActive('a')).toBe(true)
  expect(await audits()).toMatchObject([{ action: 'plugin.enable', actor_user_id: actor.uid }])
})

test('迁移失败留下 last_error，插件保持停用', async () => {
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: ['storage.tables'],
        migrations: {
          '001': {
            up: () => Promise.reject(new Error('migration sentinel')),
          },
        },
      }),
    ),
  ])
  await expect(env.core.plugins.admin.enable(await env.actor(), 'a')).rejects.toMatchObject({
    code: 'plugin_migration_failed',
  })
  expect(
    await env.db
      .selectFrom('plugins')
      .select(['is_enabled', 'last_error'])
      .where('id', '=', 'a')
      .executeTakeFirstOrThrow(),
  ).toMatchObject({ is_enabled: 0, last_error: 'migration_failed: migration sentinel' })
  expect(env.core.plugins.isActive('a')).toBe(false)
  expect(await countRows(env.db.selectFrom('plugin_migrations'))).toBe(0)
  expect(await audits()).toEqual([])
})

test('admin 不是 superadmin：所有插件管理入口都拒绝', async () => {
  await env.boot([official('a', empty())])
  const actor = await env.actor('admin')
  const admin = env.core.plugins.admin
  for (const call of [
    () => admin.list(actor),
    () => admin.detail(actor, 'a'),
    () => admin.enable(actor, 'a'),
    () => admin.disable(actor, 'a'),
    () => admin.settings(actor, 'a'),
    () => admin.updateSettings(actor, 'a', {}),
    () => admin.deadLetters(actor, 'a'),
    () => admin.retryDeadLetter(actor, 'a', -1),
    () => admin.deleteDeadLetter(actor, 'a', -1),
  ])
    await expect(call()).rejects.toMatchObject({ code: 'permission_denied' })
  expect(await countRows(env.db.selectFrom('plugins'))).toBe(0)
  expect(await audits()).toEqual([])
})

test('停用撤销拦截器和事件订阅，拒绝在途入队，保留已有任务', async () => {
  const intercept = vi.fn(async () => {})
  const received: Json[] = []
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let rejected: unknown
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        intercept: { 'user.register': intercept },
        on: { 'user.registered': async () => {} },
        jobs: {
          work: {
            handler: ({ payload }) => {
              received.push(payload)
              return Promise.resolve()
            },
          },
        },
        routes: {
          'POST /enqueue': {
            auth: 'public',
            handler: async ({ ctx }) => {
              await ctx.jobs.enqueue('work', { existing: true })
              return new Response()
            },
          },
          'POST /wait': {
            auth: 'public',
            handler: async ({ ctx }) => {
              entered.resolve()
              await resume.promise
              try {
                await ctx.jobs.enqueue('work', { late: true })
              } catch (error) {
                rejected = error
              }
              return new Response()
            },
          },
        },
      }),
    ),
  ])
  const actor = await env.actor()
  await env.core.plugins.admin.enable(actor, 'a')
  await route('/enqueue')
  await env.core.users.register(env.input())
  expect(intercept).toHaveBeenCalledTimes(1)
  const before = await env.db.selectFrom('jobs').selectAll().orderBy('id').execute()
  expect(before.map((j) => j.name).sort()).toEqual(['plugin:a:job:work', 'plugin:a:on:user.registered'])
  const pending = route('/wait')
  await entered.promise
  try {
    await env.core.plugins.admin.disable(actor, 'a')
  } finally {
    resume.resolve()
  }
  // 停用时在途的调用被中止，结果不算数
  await expect(pending).rejects.toMatchObject({ code: 'plugin_error' })
  expect(rejected).toMatchObject({ name: 'PluginCallRejected' })
  await env.core.users.register(env.input())
  await env.core.jobs.drain()
  expect(intercept).toHaveBeenCalledTimes(1)
  expect(await env.db.selectFrom('jobs').selectAll().orderBy('id').execute()).toEqual(before)
  expect(received).toEqual([])
  expect((await audits()).map((a) => a.action).sort()).toEqual(['plugin.disable', 'plugin.enable'])
})

function settingsPlugin(seen: unknown[]) {
  return official(
    'a',
    definePlugin({
      capabilities: [],
      settings: z.object({
        token: secret().default('default-token'),
        label: z
          .string()
          .refine((value) => value !== 'forbidden')
          .default('default-label'),
      }),
      jobs: {
        read: {
          handler: ({ ctx }) => {
            seen.push(ctx.settings)
            return Promise.resolve()
          },
        },
      },
    }),
  )
}

test('设置先按 JSON Schema 校验类型，再按插件 zod refine 校验', async () => {
  await env.boot([settingsPlugin([])])
  const actor = await env.actor()
  await expect(env.core.plugins.admin.updateSettings(actor, 'a', { label: 42 })).rejects.toMatchObject({
    code: 'invalid_request',
    fields: ['label'],
  })
  await expect(env.core.plugins.admin.updateSettings(actor, 'a', { label: 'forbidden' })).rejects.toMatchObject({
    code: 'invalid_request',
    fields: ['label'],
  })
  expect(await countRows(env.db.selectFrom('settings').where('namespace', '=', 'plugin:a'))).toBe(0)
  expect(await audits()).toEqual([])
})

test('机密设置加密、视图仅含 isSet、处理函数得到明文，审计不含机密值', async () => {
  const seen: unknown[] = []
  await env.boot([settingsPlugin(seen)])
  const actor = await env.actor()
  const token = 'SECRET_SETTING_CANARY'
  await env.core.plugins.admin.updateSettings(actor, 'a', { token })
  const stored = await env.db
    .selectFrom('settings')
    .select('value')
    .where('namespace', '=', 'plugin:a')
    .where('key', '=', 'token')
    .executeTakeFirstOrThrow()
  expect(stored.value).not.toContain(token)
  const envelope = JSON.parse(stored.value) as Record<string, unknown>
  expect(envelope.v).toBe(1)
  for (const key of ['iv', 'tag', 'data']) expect(typeof envelope[key]).toBe('string')
  const view = (await env.core.plugins.admin.settings(actor, 'a')).find((s) => s.key === 'token')!
  expect(view).toMatchObject({ key: 'token', isSet: true })
  expect(view).not.toHaveProperty('value')
  const known = env.core.plugins.get('a')!
  await env.core.plugins.invoke(
    { known, granted: new Set() },
    { kind: 'job', name: 'read', payload: {}, attempt: 1 },
    { timeoutMs: 1000 },
  )
  expect(seen).toEqual([{ token, label: 'default-label' }])
  const logs = await audits()
  expect(logs.map((row) => row.action)).toEqual(['plugin.settings'])
  expect(JSON.stringify(logs)).not.toContain(token)
  expect(JSON.parse(logs[0]!.details)).toEqual({ plugin: 'a', key: 'token', secret: true })
})

test('设置不变不写审计，null 删除行并恢复默认值', async () => {
  const seen: unknown[] = []
  await env.boot([settingsPlugin(seen)])
  const actor = await env.actor()
  const admin = env.core.plugins.admin
  await admin.updateSettings(actor, 'a', { token: 'custom-token', label: 'custom-label' })
  expect(await audits()).toHaveLength(2)
  expect(await admin.updateSettings(actor, 'a', { token: 'custom-token', label: 'custom-label' })).toEqual({
    updated: [],
  })
  expect(await audits()).toHaveLength(2)
  expect(await admin.updateSettings(actor, 'a', { token: null, label: null })).toEqual({ updated: ['token', 'label'] })
  expect(await countRows(env.db.selectFrom('settings').where('namespace', '=', 'plugin:a'))).toBe(0)
  expect((await admin.settings(actor, 'a')).find((s) => s.key === 'label')).toMatchObject({ value: 'default-label' })
  await env.core.plugins.invoke(
    { known: env.core.plugins.get('a')!, granted: new Set() },
    { kind: 'job', name: 'read', payload: {}, attempt: 1 },
    { timeoutMs: 1000 },
  )
  expect(seen).toEqual([{ token: 'default-token', label: 'default-label' }])
  expect(await audits()).toHaveLength(4)
})

test('存储中的设置不合法时以 settings_invalid 失败且处理函数不执行', async () => {
  const seen: unknown[] = []
  await env.boot([settingsPlugin(seen)])
  const actor = await env.actor()
  await env.core.plugins.admin.updateSettings(actor, 'a', { label: 'valid' })
  await env.db
    .updateTable('settings')
    .set({ value: JSON.stringify('forbidden') })
    .where('namespace', '=', 'plugin:a')
    .where('key', '=', 'label')
    .execute()
  await expect(
    env.core.plugins.invoke(
      { known: env.core.plugins.get('a')!, granted: new Set() },
      { kind: 'job', name: 'read', payload: {}, attempt: 1 },
      { timeoutMs: 1000 },
    ),
  ).rejects.toMatchObject({ name: 'PluginInvocationError', reason: 'settings_invalid' })
  expect(seen).toEqual([])
})

test('任务：未声明名称被拒绝，声明任务收到载荷；死信隔离、重试、删除与审计', async () => {
  const received: { payload: Json; attempt: number }[] = []
  let rejection: unknown
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        jobs: {
          ok: {
            handler: ({ payload, attempt }) => {
              received.push({ payload, attempt })
              return Promise.resolve()
            },
          },
          fail: {
            maxAttempts: 1,
            handler: () => Promise.reject(new Error('job sentinel')),
          },
        },
        routes: {
          'POST /enqueue': {
            auth: 'public',
            handler: async ({ ctx }) => {
              try {
                await ctx.jobs.enqueue('missing', {})
              } catch (error) {
                rejection = error
              }
              await ctx.jobs.enqueue('ok', { message: 'hello' })
              await ctx.jobs.enqueue('fail', { fail: true })
              return new Response()
            },
          },
        },
      }),
    ),
    official('b', empty()),
  ])
  const actor = await env.actor()
  await env.core.plugins.admin.enable(actor, 'a')
  await route('/enqueue')
  expect(rejection).toMatchObject({ name: 'PluginCallRejected' })
  expect((await env.db.selectFrom('jobs').select('name').execute()).map((j) => j.name).sort()).toEqual([
    'plugin:a:job:fail',
    'plugin:a:job:ok',
  ])
  await env.core.jobs.drain()
  expect(received).toEqual([{ payload: { message: 'hello' }, attempt: 1 }])
  expect(await countRows(env.db.selectFrom('jobs'))).toBe(0)
  const admin = env.core.plugins.admin
  const [dead] = await admin.deadLetters(actor, 'a')
  expect(dead).toMatchObject({ name: 'plugin:a:job:fail', lastError: 'job sentinel', attempts: 1 })
  expect(await admin.deadLetters(actor, 'b')).toEqual([])
  await expect(admin.retryDeadLetter(actor, 'b', dead!.id)).rejects.toMatchObject({ code: 'dead_letter_not_found' })
  await expect(admin.deleteDeadLetter(actor, 'b', dead!.id)).rejects.toMatchObject({ code: 'dead_letter_not_found' })
  await admin.retryDeadLetter(actor, 'a', dead!.id)
  expect(await admin.deadLetters(actor, 'a')).toEqual([])
  expect(await env.db.selectFrom('jobs').select(['name', 'attempts']).execute()).toEqual([
    { name: 'plugin:a:job:fail', attempts: 0 },
  ])
  await env.core.jobs.drain()
  const [again] = await admin.deadLetters(actor, 'a')
  await admin.deleteDeadLetter(actor, 'a', again!.id)
  expect(await admin.deadLetters(actor, 'a')).toEqual([])
  expect(
    (await audits())
      .filter((a) => a.action === 'plugin.deadLetter')
      .map((a) => JSON.parse(a.details) as { plugin: string; job: number; action: string })
      .sort((a, b) => a.action.localeCompare(b.action)),
  ).toEqual([
    { plugin: 'a', job: again!.id, action: 'delete' },
    { plugin: 'a', job: dead!.id, action: 'retry' },
  ])
})
