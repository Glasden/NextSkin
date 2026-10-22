import { getMessages, locales } from '@nextskin/i18n'
import {
  coreMigrations,
  countRows,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  upsert,
  writeAuthDate,
  type CoreDatabase,
  type UserRole,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import type { KyselyPlugin } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { createCore, type Core } from '../core.ts'
import { createNotifications } from './service.ts'
import { notify, notifyPendingReport } from './write.ts'
import {
  createNotificationJobs,
  NOTIFICATION_FANOUT_JOB,
  NOTIFICATION_RECALL_JOB,
  NOTIFICATION_SWEEP_JOB,
} from './jobs.ts'

let database: TestDatabase<CoreDatabase>
let core: Core
let timestamp: Date
let sequence = 0
let admin: { uid: number; ip: null }
const db = () => database.db
const at = (days = 0) => toIsoTimestamp(new Date(timestamp.getTime() + days * 86_400_000))
const userRow = (role: UserRole = 'user') => ({
  nickname: `用户${++sequence}`,
  email: `user${sequence}@example.test`,
  email_verified: true,
  created_at: writeAuthDate(db(), at()),
  updated_at: writeAuthDate(db(), at()),
  role,
})
const user = (role: UserRole = 'user') => insertReturningId(db(), 'users', userRow(role))
const notifications = () => db().selectFrom('notifications').selectAll().orderBy('id').execute()
const broadcast = (id: number) =>
  db().selectFrom('notification_broadcasts').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
const actor = (uid: number) => ({ uid, ip: null })
function jobs(budgetMs = 20_000) {
  return createNotificationJobs({ db: db(), jobs: core.jobs, settings: core.settings, now: () => timestamp, budgetMs })
}
async function run(name: string, broadcastId?: number, budgetMs?: number) {
  const job = await db()
    .selectFrom('jobs')
    .select('id')
    .where('name', '=', name)
    .orderBy('id', 'desc')
    .executeTakeFirst()
  await jobs(budgetMs)[name]!.run({
    jobId: job?.id ?? 0,
    payload: broadcastId === undefined ? {} : { broadcastId },
    attempt: 1,
    signal: new AbortController().signal,
  })
}
async function system(uid: number, count = 1, days = 0) {
  for (let i = 0; i < count; i++)
    await db()
      .transaction()
      .execute((tx) => notify(tx, uid, 'report.pending', {}, at(days)))
}
async function bulkUsers(count: number, role: UserRole) {
  for (let i = 0; i < count; i += 100)
    await db()
      .insertInto('users')
      .values(Array.from({ length: Math.min(100, count - i) }, () => userRow(role)))
      .execute()
}
async function retention(days: number) {
  await upsert(db(), 'settings', {
    values: { namespace: 'core', key: 'notifications.retentionDays', value: JSON.stringify(days), updated_at: at() },
    conflict: ['namespace', 'key'],
    update: ['value'],
  })
}
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
})
afterAll(async () => database?.cleanup())
afterEach(async () => core?.shutdown())
beforeEach(async () => {
  for (const table of [
    'notifications',
    'notification_broadcasts',
    'plugin_notification_keys',
    'audit_logs',
    'jobs',
    'failed_jobs',
    'settings',
    'users',
  ] as const)
    await db().deleteFrom(table).execute()
  timestamp = new Date('2030-02-01T00:00:00.000Z')
  core = createCore({
    db: db(),
    secretKey: 'test-secret-with-at-least-32-characters',
    production: false,
    now: () => timestamp,
    textureStorage: {
      lateDeleteWindowMs: 0,
      list: () => Promise.resolve([]),
      listTemp: () => Promise.resolve([]),
      write: async () => {},
      read: () => Promise.resolve(null),
      delete: async () => {},
      deleteTemp: async () => {},
    },
  })
  admin = actor(await user('admin'))
})

test('群发不按身份扫描，500 人一批续跑，水位之后注册的人收不到，重跑不重复', async () => {
  await bulkUsers(1000, 'banned')
  const recipient = await user()
  const { id } = await core.admin.sendNotification(admin, { audience: 'all', title: '  标题  ', body: '**正文**' })
  const later = await user()
  await run(NOTIFICATION_FANOUT_JOB, id, 0)
  expect(await broadcast(id)).toMatchObject({ status: 'sending', recipient_count: 1, title: '标题' })
  expect((await notifications()).map((row) => row.user_id)).toEqual([admin.uid])
  const queued = await db()
    .selectFrom('jobs')
    .select(['id', 'dedupe_key'])
    .where('name', '=', NOTIFICATION_FANOUT_JOB)
    .orderBy('id')
    .execute()
  expect(queued.map((row) => row.dedupe_key)).toEqual([null, `notification-fanout:${id}`])
  await run(NOTIFICATION_FANOUT_JOB, id, 0)
  expect(await broadcast(id)).toMatchObject({ status: 'sending', recipient_count: 1 })
  await run(NOTIFICATION_FANOUT_JOB, id)
  expect(await broadcast(id)).toMatchObject({
    status: 'sent',
    recipient_count: 2,
    through_uid: recipient,
    cursor_uid: recipient,
    finished_at: at(),
  })
  await run(NOTIFICATION_FANOUT_JOB, id)
  expect((await notifications()).map((row) => row.user_id)).toEqual([admin.uid, recipient])
  expect((await notifications()).every((row) => row.created_at === at())).toBe(true)
  expect((await core.notifications.summary(later, 'zh-CN')).unread).toBe(0)
})

test.each(['users', 'admins'] as const)('%s 按展开时的身份过滤', async (audience) => {
  const normal = await user()
  const promoted = await user()
  const superadmin = await user('superadmin')
  await user('banned')
  const { id } = await core.admin.sendNotification(admin, { audience, title: 'x', body: '' })
  await db().updateTable('users').set({ role: 'admin' }).where('id', '=', promoted).execute()
  await run(NOTIFICATION_FANOUT_JOB, id)
  expect((await notifications()).map((row) => row.user_id)).toEqual(
    audience === 'users' ? [normal] : [admin.uid, promoted, superadmin],
  )
})

test('指定 uid 和邮箱去重，可发给封禁用户；未知收件人整体回滚并按字段报错', async () => {
  const uid = await user('banned')
  const email = (await db().selectFrom('users').select('email').where('id', '=', uid).executeTakeFirstOrThrow()).email
  const input = {
    audience: 'specific' as const,
    title: '😀'.repeat(60),
    body: '😀'.repeat(5000),
    recipients: [String(uid), email.toUpperCase(), String(uid)],
  }
  const { id } = await core.admin.sendNotification(admin, input)
  expect(await broadcast(id)).toMatchObject({ status: 'sent', recipient_count: 1, through_uid: uid, cursor_uid: uid })
  expect(await notifications()).toHaveLength(1)
  expect(await db().selectFrom('jobs').select('id').where('name', '=', NOTIFICATION_FANOUT_JOB).execute()).toEqual([])
  await expect(
    core.admin.sendNotification(admin, { ...input, recipients: [String(uid), 'missing@example.test'] }),
  ).rejects.toMatchObject({
    code: 'notification_recipient_unknown',
    params: { value: 'missing@example.test' },
    fields: ['recipients'],
  })
  expect(await countRows(db().selectFrom('notification_broadcasts'))).toBe(1)
  expect(await db().selectFrom('audit_logs').select('details').execute()).toEqual([
    { details: JSON.stringify({ audience: 'specific', uids: [uid] }) },
  ])
})

test('发送和撤回权限，标题正文的码位和指定人数校验', async () => {
  const normal = actor(await user())
  await expect(core.admin.sendNotification(normal, { audience: 'all', title: 'x', body: '' })).rejects.toMatchObject({
    code: 'permission_denied',
  })
  await expect(core.admin.listNotificationBroadcasts(normal, { page: 1 })).rejects.toMatchObject({
    code: 'permission_denied',
  })
  await expect(core.admin.recallNotification(normal, 1)).rejects.toMatchObject({ code: 'permission_denied' })
  for (const title of ['', ' ', '😀'.repeat(61)])
    await expect(core.admin.sendNotification(admin, { audience: 'all', title, body: '' })).rejects.toMatchObject({
      code: 'notification_title_length',
    })
  await expect(
    core.admin.sendNotification(admin, { audience: 'all', title: 'x', body: '😀'.repeat(5001) }),
  ).rejects.toMatchObject({
    code: 'notification_body_length',
  })
  for (const recipients of [undefined, [], Array.from({ length: 51 }, () => String(admin.uid))])
    await expect(
      core.admin.sendNotification(admin, { audience: 'specific', title: 'x', body: '', recipients }),
    ).rejects.toMatchObject({ code: 'notification_recipients_length' })
})

test('展开中撤回立即隐藏，下一批停止，分批删光；重复撤回和不存在分别报错', async () => {
  await bulkUsers(1100, 'user')
  const { id } = await core.admin.sendNotification(admin, { audience: 'all', title: 'x', body: '' })
  await run(NOTIFICATION_FANOUT_JOB, id, 0)
  const other = actor(await user('admin'))
  await core.admin.recallNotification(other, id)
  expect(await core.notifications.summary(admin.uid, 'zh-CN')).toEqual({ unread: 0, latest: [] })
  expect(await core.notifications.list(admin.uid, 'en', { filter: 'all', page: 1 })).toEqual({
    total: 0,
    unread: 0,
    latestId: null,
    items: [],
  })
  await run(NOTIFICATION_FANOUT_JOB, id)
  expect(await notifications()).toHaveLength(500)
  await expect(core.admin.recallNotification(admin, id)).rejects.toMatchObject({
    code: 'notification_broadcast_recalled',
  })
  await expect(core.admin.recallNotification(admin, 2147483647)).rejects.toMatchObject({
    code: 'notification_broadcast_not_found',
  })
  await run(NOTIFICATION_RECALL_JOB, id)
  expect(await notifications()).toEqual([])
  expect(await broadcast(id)).toMatchObject({ status: 'recalled', recipient_count: 500 })
  expect(
    await db().selectFrom('audit_logs').select('details').where('action', '=', 'notification.recall').execute(),
  ).toEqual([{ details: '{"recipientCount":500}' }])
})

test('已发送撤回的清理也按 1000 行续跑，重复任务安全', async () => {
  await bulkUsers(1100, 'user')
  const { id } = await core.admin.sendNotification(admin, { audience: 'all', title: 'x', body: '' })
  await run(NOTIFICATION_FANOUT_JOB, id)
  await run(NOTIFICATION_RECALL_JOB, id)
  expect(await notifications()).toHaveLength(1101)
  await core.admin.recallNotification(admin, id)
  await run(NOTIFICATION_RECALL_JOB, id, 0)
  expect(await notifications()).toHaveLength(101)
  const queued = await db()
    .selectFrom('jobs')
    .select('dedupe_key')
    .where('name', '=', NOTIFICATION_RECALL_JOB)
    .orderBy('id')
    .execute()
  expect(queued).toEqual([{ dedupe_key: null }, { dedupe_key: `notification-recall:${id}` }])
  await run(NOTIFICATION_RECALL_JOB, id)
  await run(NOTIFICATION_RECALL_JOB, id)
  expect(await notifications()).toEqual([])
})

test('用户只能标读和删自己的，已读时间不变；分页、封顶、through 和 latestId', async () => {
  const uid = await user()
  await system(uid, 105)
  await system(admin.uid)
  const own = (await notifications()).filter((row) => row.user_id === uid)
  const latestId = own.at(-1)!.id
  const page = await core.notifications.list(uid, 'en', { filter: 'all', page: 2 })
  expect(page).toMatchObject({ total: 105, unread: 100, latestId })
  expect(page.items).toHaveLength(20)
  expect(page.items[0]!.id).toBe(own.at(-21)!.id)
  expect((await core.notifications.summary(uid, 'en')).latest.map((row) => row.id)).toEqual(
    own
      .slice(-5)
      .reverse()
      .map((row) => row.id),
  )
  await expect(core.notifications.markRead(admin.uid, latestId)).rejects.toMatchObject({
    code: 'notification_not_found',
  })
  await expect(core.notifications.remove(admin.uid, latestId)).rejects.toMatchObject({ code: 'notification_not_found' })
  expect(
    (await core.notifications.list(admin.uid, 'en', { filter: 'all', page: 1 })).items.every(
      (row) => row.id !== latestId,
    ),
  ).toBe(true)
  await core.notifications.markRead(uid, latestId)
  timestamp = new Date(timestamp.getTime() + 1000)
  await core.notifications.markRead(uid, latestId)
  expect((await notifications()).find((row) => row.id === latestId)!.read_at).toBe('2030-02-01T00:00:00.000Z')
  expect(await core.notifications.markAllRead(uid, own[49]!.id)).toBe(50)
  expect(await core.notifications.markAllRead(uid, own[49]!.id)).toBe(0)
  expect(await core.notifications.list(uid, 'en', { filter: 'unread', page: 1 })).toMatchObject({
    total: 54,
    unread: 54,
    latestId,
  })
  await core.notifications.remove(uid, latestId)
  await expect(core.notifications.remove(uid, latestId)).rejects.toMatchObject({ code: 'notification_not_found' })
  expect((await core.notifications.list(uid, 'en', { filter: 'all', page: 1 })).latestId).toBe(own.at(-2)!.id)
})

test('列表先定水位：读的中途新到的通知不显示、不计数，latestId 也不包括它', async () => {
  const uid = await user()
  await system(uid, 2)
  const before = (await notifications()).at(-1)!.id
  let arrived = false
  const arrive: KyselyPlugin = {
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      // 查身份之后的第一个查询读完，就再到一条
      if (!arrived && result.rows[0] && !('role' in result.rows[0])) {
        arrived = true
        await system(uid)
      }
      return result
    },
  }
  const racing = createNotifications({
    db: db().withPlugin(arrive),
    plugins: core.plugins,
    now: () => timestamp,
  })
  const page = await racing.list(uid, 'en', { filter: 'all', page: 1 })
  expect(arrived).toBe(true)
  expect(page).toMatchObject({ total: 2, unread: 2, latestId: before })
  expect(page.items.map((item) => item.id)).toEqual(
    (await notifications())
      .filter((row) => row.id <= before)
      .map((row) => row.id)
      .reverse(),
  )
  expect(await core.notifications.markAllRead(uid, page.latestId!)).toBe(2)
  expect(await core.notifications.list(uid, 'en', { filter: 'unread', page: 1 })).toMatchObject({
    total: 1,
    unread: 1,
  })
})

test('封禁用户的通知仍保留，用户中心接口拒绝访问，解封可读', async () => {
  const uid = await user('banned')
  await system(uid)
  for (const call of [
    () => core.notifications.summary(uid, 'en'),
    () => core.notifications.list(uid, 'en', { filter: 'all', page: 1 }),
    () => core.notifications.markRead(uid, 1),
    () => core.notifications.markAllRead(uid, 1),
    () => core.notifications.remove(uid, 1),
  ])
    await expect(call()).rejects.toMatchObject({ code: 'user_banned' })
  await db().updateTable('users').set({ role: 'user' }).where('id', '=', uid).execute()
  expect((await core.notifications.summary(uid, 'en')).unread).toBe(1)
})

test('清理保留期和 0，不删展开中的群发或插件幂等键', async () => {
  await system(admin.uid, 1, -366)
  await system(admin.uid, 1, -365)
  await db()
    .insertInto('plugin_notification_keys')
    .values({
      plugin_id: 'example',
      plugin_key: 'forever',
      user_id: admin.uid,
      fingerprint: 'a'.repeat(64),
      created_at: at(-400),
    })
    .execute()
  const send = async () =>
    core.admin.sendNotification(admin, { audience: 'specific', title: 'x', body: '', recipients: [String(admin.uid)] })
  const old = await send()
  const sending = await send()
  await db()
    .updateTable('notification_broadcasts')
    .set({ created_at: at(-366) })
    .execute()
  await db().updateTable('notification_broadcasts').set({ status: 'sending' }).where('id', '=', sending.id).execute()
  await retention(0)
  await run(NOTIFICATION_SWEEP_JOB)
  expect(await notifications()).toHaveLength(4)
  await retention(365)
  await run(NOTIFICATION_SWEEP_JOB)
  expect(await db().selectFrom('notification_broadcasts').select('id').execute()).toEqual([{ id: sending.id }])
  expect((await notifications()).map((row) => row.created_at)).toEqual([at(-365), at()])
  expect(await countRows(db().selectFrom('plugin_notification_keys'))).toBe(1)
  expect(old.id).not.toBe(sending.id)
})

test('report.pending 由权限映射选择管理员，排除自己，读过后才能再通知；收件人不存在和回滚不留通知', async () => {
  const superadmin = await user('superadmin')
  const normal = await user()
  await user('banned')
  await db()
    .transaction()
    .execute((tx) => notifyPendingReport(tx, admin.uid, at()))
  await db()
    .transaction()
    .execute((tx) => notifyPendingReport(tx, normal, at()))
  await db()
    .transaction()
    .execute((tx) => notifyPendingReport(tx, normal, at()))
  expect((await notifications()).map((row) => row.user_id)).toEqual([superadmin, admin.uid])
  await core.notifications.markAllRead(superadmin, (await notifications()).at(-1)!.id)
  await db()
    .transaction()
    .execute((tx) => notifyPendingReport(tx, normal, at()))
  expect(await notifications()).toHaveLength(3)
  await system(2147483647)
  expect(await notifications()).toHaveLength(3)
  await expect(
    db()
      .transaction()
      .execute(async (tx) => {
        await notify(tx, normal, 'report.pending', {}, at())
        throw new Error('rollback')
      }),
  ).rejects.toThrow('rollback')
  expect(await notifications()).toHaveLength(3)
})

test('发送记录分页和发送人删除后的空值', async () => {
  for (let i = 0; i < 51; i++)
    await core.admin.sendNotification(admin, {
      audience: 'specific',
      title: String(i),
      body: '',
      recipients: [String(admin.uid)],
    })
  expect(await core.admin.listNotificationBroadcasts(admin, { page: 2 })).toMatchObject({
    total: 51,
    items: [{ title: '0', sender: { uid: admin.uid } }],
  })
  const other = actor(await user('admin'))
  await db().deleteFrom('users').where('id', '=', admin.uid).execute()
  expect(
    (await core.admin.listNotificationBroadcasts(other, { page: 1 })).items.every((row) => row.sender === null),
  ).toBe(true)
})

test('两个展开任务竞争同一批时不重复，撤回与下一批竞争后不再写入', async () => {
  await bulkUsers(1100, 'user')
  const { id } = await core.admin.sendNotification(admin, { audience: 'all', title: 'x', body: '' })
  await Promise.all([run(NOTIFICATION_FANOUT_JOB, id, 0), run(NOTIFICATION_FANOUT_JOB, id, 0)])
  expect(await broadcast(id)).toMatchObject({ status: 'sending', recipient_count: 1000 })
  const rows = await notifications()
  expect(new Set(rows.map((row) => row.user_id)).size).toBe(1000)
  await Promise.all([run(NOTIFICATION_FANOUT_JOB, id, 0), core.admin.recallNotification(admin, id)])
  expect((await core.notifications.summary(admin.uid, 'en')).unread).toBe(0)
  const count = (await broadcast(id)).recipient_count
  await run(NOTIFICATION_FANOUT_JOB, id)
  expect((await broadcast(id)).recipient_count).toBe(count)
  await run(NOTIFICATION_RECALL_JOB, id)
  expect(await notifications()).toEqual([])
})

test('核心登记三个任务，失败任务能识别载荷，两个语言都有任务名', async () => {
  const superadmin = await user('superadmin')
  for (const [name, label] of [
    [NOTIFICATION_FANOUT_JOB, 'notificationFanout'],
    [NOTIFICATION_RECALL_JOB, 'notificationRecall'],
    [NOTIFICATION_SWEEP_JOB, 'notificationSweep'],
  ] as const) {
    await db()
      .insertInto('failed_jobs')
      .values({
        name,
        payload: JSON.stringify({ broadcastId: 1 }),
        dedupe_key: null,
        attempts: 5,
        last_error: 'error',
        created_at: at(),
        failed_at: at(),
      })
      .execute()
    for (const locale of locales) expect(getMessages(locale).admin.failedJobs.names[label]).toEqual(expect.any(String))
  }
  const list = await core.admin.listFailedJobs(superadmin, { page: 1 })
  expect(list.items).toHaveLength(3)
  expect(list.items.every((row) => row.retryable)).toBe(true)
  expect(jobs()[NOTIFICATION_FANOUT_JOB]!.retryable!({})).toBe(false)
  expect(jobs()[NOTIFICATION_RECALL_JOB]!.retryable!({ broadcastId: -1 })).toBe(false)
})
