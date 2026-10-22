import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import type { Kysely, KyselyPlugin, QueryId } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { PluginCallRejected } from '../plugins/errors.ts'
import { sendPluginNotification, type PluginNotificationInput } from './plugin.ts'
import { createNotifications } from './service.ts'

const now = new Date('2040-03-31T12:00:00.000Z')
let database: TestDatabase<CoreDatabase>
let db: Kysely<CoreDatabase>
let uid: number
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  db = database.db
  await migrateToLatest(db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db.deleteFrom('plugin_notification_keys').execute()
  await db.deleteFrom('users').execute()
  uid = await insertReturningId(db, 'users', {
    nickname: '通知测试',
    email: 'plugin-notice@example.test',
    email_verified: true,
    created_at: writeAuthDate(db, toIsoTimestamp(now)),
    updated_at: writeAuthDate(db, toIsoTimestamp(now)),
  })
})
const input = (patch: Partial<PluginNotificationInput> = {}): PluginNotificationInput => ({
  pluginId: 'notice',
  uid,
  title: 'notice.title',
  body: 'notice.body',
  params: { name: 'Alex', count: 1 },
  link: '/user',
  key: 'once',
  now,
  ...patch,
})
const send = (patch: Partial<PluginNotificationInput> = {}) => sendPluginNotification(db, input(patch))
const rows = () => db.selectFrom('notifications').selectAll().execute()
const keys = () => db.selectFrom('plugin_notification_keys').selectAll().execute()

test('sent 写入通知与永久键，不写审计或事件', async () => {
  expect(await send()).toEqual({ status: 'sent' })
  expect(await rows()).toMatchObject([
    {
      user_id: uid,
      type: 'plugin',
      plugin_id: 'notice',
      title_key: 'notice.title',
      body_key: 'notice.body',
      params: '{"count":1,"name":"Alex"}',
      link: '/user',
      read_at: null,
      created_at: toIsoTimestamp(now),
    },
  ])
  expect(await keys()).toEqual([
    {
      plugin_id: 'notice',
      plugin_key: 'once',
      user_id: uid,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
      created_at: toIsoTimestamp(now),
    },
  ])
  expect(await db.selectFrom('audit_logs').selectAll().execute()).toEqual([])
  expect(await db.selectFrom('jobs').selectAll().execute()).toEqual([])
})

test('同 key 同参数或 params 键顺序不同返回 duplicate，不多写通知', async () => {
  await send()
  expect(await send()).toEqual({ status: 'duplicate' })
  expect(await send({ params: { count: 1, name: 'Alex' }, now: new Date() })).toEqual({ status: 'duplicate' })
  expect(await rows()).toHaveLength(1)
  expect(await keys()).toHaveLength(1)
})

test('同 key 任一字段不同都拒绝，包括缺省字段与空 params', async () => {
  await send()
  const patches: Partial<PluginNotificationInput>[] = [
    { uid: uid + 1 },
    { title: 'other.title' },
    { body: 'other.body' },
    { body: undefined },
    { params: { count: 2, name: 'Alex' } },
    { params: undefined },
    { params: {} },
    { link: '/other' },
    { link: undefined },
  ]
  for (const patch of patches) await expect(send(patch)).rejects.toThrow(PluginCallRejected)
  expect(await rows()).toHaveLength(1)
  expect(await keys()).toHaveLength(1)
})

test('可选字段缺省按 null 存储并稳定去重', async () => {
  const patch = { body: undefined, params: undefined, link: undefined }
  expect(await send(patch)).toEqual({ status: 'sent' })
  expect(await send(patch)).toEqual({ status: 'duplicate' })
  expect(await rows()).toMatchObject([{ body_key: null, params: null, link: null }])
})

test('用户不存在返回 userNotFound，不占 key，合法大 uid 不溢出', async () => {
  for (const missing of [2147483647, 2147483648, Number.MAX_SAFE_INTEGER])
    expect(await send({ uid: missing })).toEqual({ status: 'userNotFound' })
  expect(await keys()).toEqual([])
  expect(await rows()).toEqual([])
  expect(await send()).toEqual({ status: 'sent' })
})

test('用户删除通知后同 key 仍是 duplicate，删除用户后也先认永久键', async () => {
  await send()
  const [row] = await rows()
  const notifications = createNotifications({
    db,
    now: () => now,
    plugins: { get: () => undefined, translate: () => '' },
  })
  await notifications.remove(uid, row!.id)
  expect(await send()).toEqual({ status: 'duplicate' })
  expect(await rows()).toEqual([])
  await db.deleteFrom('users').where('id', '=', uid).execute()
  expect(await send()).toEqual({ status: 'duplicate' })
  expect(await keys()).toHaveLength(1)
})

test('不检查封禁，不同插件同 key 独立', async () => {
  await db.updateTable('users').set({ role: 'banned' }).where('id', '=', uid).execute()
  expect(await send()).toEqual({ status: 'sent' })
  expect(await send({ pluginId: 'other' })).toEqual({ status: 'sent' })
  expect(await rows()).toHaveLength(2)
})

test('并发同 key 只写一条，参数冲突仅有一方成功', async () => {
  expect((await Promise.all([send(), send()])).map((r) => r.status).sort()).toEqual(['duplicate', 'sent'])
  const conflict = await Promise.allSettled([send({ key: 'race', title: 'a' }), send({ key: 'race', title: 'b' })])
  expect(conflict.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(conflict.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { name: 'PluginCallRejected' } }])
  expect(await rows()).toHaveLength(2)
  expect(await keys()).toHaveLength(2)
})

test.each([false, true])('主键冲突整体回滚，在事务外重读永久键（参数冲突=%s）', async (conflict) => {
  await send()
  let selects = 0
  const missed = new Set<QueryId>()
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === 'SelectQueryNode' && JSON.stringify(node).includes('"plugin_notification_keys"')) {
        if (++selects === 1) missed.add(queryId)
      }
      return node
    },
    transformResult({ result, queryId }) {
      return Promise.resolve(missed.has(queryId) ? { ...result, rows: [] } : result)
    },
  }
  const replay = sendPluginNotification(db.withPlugin(plugin), input(conflict ? { title: 'other' } : {}))
  if (conflict) await expect(replay).rejects.toThrow('同一个 key 已经用于另一条通知')
  else expect(await replay).toEqual({ status: 'duplicate' })
  expect(selects).toBe(2)
  expect(await rows()).toHaveLength(1)
  expect(await keys()).toHaveLength(1)
})

test('通知插入失败时永久键一起回滚，原 key 可以重试', async () => {
  const failure = new Error('notification insert failed')
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (node.kind === 'InsertQueryNode' && JSON.stringify(node).includes('"notifications"')) throw failure
      return node
    },
    transformResult({ result }) {
      return Promise.resolve(result)
    },
  }
  await expect(sendPluginNotification(db.withPlugin(plugin), input())).rejects.toBe(failure)
  expect(await rows()).toEqual([])
  expect(await keys()).toEqual([])
  expect(await send()).toEqual({ status: 'sent' })
})
