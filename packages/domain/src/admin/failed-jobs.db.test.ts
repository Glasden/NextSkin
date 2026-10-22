import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
  type UserRole,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createCore, type Core } from '../index.ts'
import { MAIL_JOB } from '../mail/service.ts'
import type { AdminActor } from './types.ts'

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
let database: TestDatabase<CoreDatabase>
let core: Core
let superadmin: AdminActor
let admin: AdminActor
let recipient: number

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  for (const table of ['audit_logs', 'jobs', 'failed_jobs', 'users'] as const)
    await database.db.deleteFrom(table).execute()
  core = createCore({
    db: database.db,
    secretKey,
    production: false,
    textureStorage: {
      list: () => Promise.resolve([]),
      listTemp: () => Promise.resolve([]),
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
    mailTransport: { send: () => Promise.resolve({ messageId: null }) },
  })
  superadmin = { uid: await user('super', 'superadmin'), ip: '192.0.2.1' }
  admin = { uid: await user('admin', 'admin'), ip: '192.0.2.2' }
  recipient = await user('steve', 'user')
})

async function user(name: string, role: UserRole): Promise<number> {
  const now = writeAuthDate(database.db, toIsoTimestamp(new Date()))
  return insertReturningId(database.db, 'users', {
    nickname: name,
    email: `${name}@example.test`,
    email_verified: true,
    role,
    created_at: now,
    updated_at: now,
  })
}

let clock = Date.parse('2026-10-01T00:00:00.000Z')
async function dead(name: string, payload: unknown, options: { lastError?: string; dedupeKey?: string } = {}) {
  clock += 60_000
  return insertReturningId(database.db, 'failed_jobs', {
    name,
    payload: JSON.stringify(payload),
    dedupe_key: options.dedupeKey ?? null,
    attempts: 5,
    last_error: options.lastError ?? 'error',
    created_at: toIsoTimestamp(new Date(clock - 3_600_000)),
    failed_at: toIsoTimestamp(new Date(clock)),
  })
}
const emailChanged = () => ({ template: 'emailChanged', to: 'old@example.test', uid: recipient })
// 进死信时去掉了链接的找回密码邮件
const stripped = () => ({ template: 'resetPassword', to: 'steve@example.test', uid: recipient })
async function audits() {
  return (await database.db.selectFrom('audit_logs').selectAll().orderBy('id').execute()).map((row) => ({
    action: row.action,
    subject: [row.subject_type, row.subject_id],
    actor: row.actor_user_id,
    details: JSON.parse(row.details) as unknown,
  }))
}
const queued = () => database.db.selectFrom('jobs').select(['name', 'payload', 'attempts', 'dedupe_key']).execute()
const remaining = async () =>
  (await database.db.selectFrom('failed_jobs').select('id').orderBy('id').execute()).map((row) => row.id)

test('只有 jobs.manage（超级管理员）能看、能处理；概览上的计数也只给他', async () => {
  const id = await dead(MAIL_JOB, emailChanged())
  for (const viewer of [admin, { uid: recipient, ip: null }]) {
    await expect(core.admin.listFailedJobs(viewer.uid, { page: 1 })).rejects.toMatchObject({
      code: 'permission_denied',
    })
    for (const call of [
      () => core.admin.retryFailedJob(viewer, id),
      () => core.admin.deleteFailedJob(viewer, id),
      () => core.admin.retryAllFailedJobs(viewer, id),
      () => core.admin.deleteAllFailedJobs(viewer, id),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'permission_denied' })
  }
  expect(await remaining()).toEqual([id])
  expect((await core.admin.overview(admin.uid)).failedJobs).toBeNull()
  await dead('plugin:a:job', {})
  expect((await core.admin.overview(superadmin.uid)).failedJobs).toBe(1)
})

test('列表只有核心任务，最新的在前；邮件给出收件人，能不能重试按处理函数判断', async () => {
  const changed = await dead(MAIL_JOB, emailChanged(), { lastError: 'smtp:EAUTH:535' })
  const reset = await dead(MAIL_JOB, stripped())
  await dead('plugin:a:job', { secret: 'plugin' })
  const cleanup = await dead('core:auth-cleanup', {})
  const unknown = await dead('core:removed-job', {})
  const broken = await insertReturningId(database.db, 'failed_jobs', {
    name: 'core:texture-recycle',
    payload: '{not json',
    dedupe_key: null,
    attempts: 1,
    last_error: null,
    created_at: toIsoTimestamp(new Date(clock)),
    failed_at: toIsoTimestamp(new Date(clock)),
  })
  const alex = await user('alex', 'user')
  await database.db.deleteFrom('users').where('id', '=', recipient).execute()
  const gone = await dead(MAIL_JOB, emailChanged())
  recipient = alex
  const live = await dead(MAIL_JOB, emailChanged())

  const page = await core.admin.listFailedJobs(superadmin.uid, { page: 1 })
  expect(page.total).toBe(7)
  expect(page.latestId).toBe(live)
  expect(page.items.map((item) => [item.id, item.retryable])).toEqual([
    [live, true],
    [gone, true],
    [broken, false],
    [unknown, false],
    [cleanup, true],
    [reset, false],
    [changed, true],
  ])
  expect(page.items[0]).toMatchObject({
    name: MAIL_JOB,
    payload: emailChanged(),
    attempts: 5,
    user: { uid: recipient, nickname: 'alex' },
  })
  expect(page.items[1]!.user).toBeNull()
  expect(page.items[2]).toMatchObject({ payload: null, lastError: null })
  expect(page.items[6]!.lastError).toBe('smtp:EAUTH:535')

  const second = await core.admin.listFailedJobs(superadmin.uid, { page: 2, perPage: 5 })
  expect(second.items.map((item) => item.id)).toEqual([reset, changed])
  expect(second.latestId).toBe(live)
})

test('重试放回队列，attempts 从 0 开始；不能重试的、插件的、不存在的都拒绝', async () => {
  const changed = await dead(MAIL_JOB, emailChanged(), { dedupeKey: 'notice' })
  const reset = await dead(MAIL_JOB, stripped())
  const unknown = await dead('core:removed-job', {})
  const plugin = await dead('plugin:a:job', {})

  await core.admin.retryFailedJob(superadmin, changed)
  expect(await queued()).toEqual([
    { name: MAIL_JOB, payload: JSON.stringify(emailChanged()), attempts: 0, dedupe_key: 'notice' },
  ])
  await expect(core.admin.retryFailedJob(superadmin, changed)).rejects.toMatchObject({
    code: 'dead_letter_not_found',
  })
  for (const id of [reset, unknown])
    await expect(core.admin.retryFailedJob(superadmin, id)).rejects.toMatchObject({
      code: 'dead_letter_not_retryable',
    })
  for (const id of [plugin, 2147483647])
    await expect(core.admin.retryFailedJob(superadmin, id)).rejects.toMatchObject({ code: 'dead_letter_not_found' })
  expect(await remaining()).toEqual([reset, unknown, plugin])
  expect(await audits()).toEqual([
    {
      action: 'job.deadLetter',
      subject: ['job', changed],
      actor: superadmin.uid,
      details: { action: 'retry', name: MAIL_JOB },
    },
  ])
})

test('同一去重键的任务已经在队列里时，重试直接丢掉这条死信', async () => {
  const id = await dead(MAIL_JOB, emailChanged(), { dedupeKey: 'notice' })
  await core.jobs.enqueue(
    database.db,
    MAIL_JOB,
    { template: 'emailChanged', to: 'new@example.test', uid: recipient },
    {
      dedupeKey: 'notice',
    },
  )
  await core.admin.retryFailedJob(superadmin, id)
  expect(await remaining()).toEqual([])
  expect((await queued()).map((job) => JSON.parse(job.payload) as unknown)).toEqual([
    { template: 'emailChanged', to: 'new@example.test', uid: recipient },
  ])
})

test('删除不论能不能重试，插件的和不存在的拒绝', async () => {
  const reset = await dead(MAIL_JOB, stripped())
  const plugin = await dead('plugin:a:job', {})
  await core.admin.deleteFailedJob(superadmin, reset)
  for (const id of [reset, plugin])
    await expect(core.admin.deleteFailedJob(superadmin, id)).rejects.toMatchObject({ code: 'dead_letter_not_found' })
  expect(await remaining()).toEqual([plugin])
  expect(await queued()).toEqual([])
  expect(await audits()).toEqual([
    {
      action: 'job.deadLetter',
      subject: ['job', reset],
      actor: superadmin.uid,
      details: { action: 'delete', name: MAIL_JOB },
    },
  ])
})

test('全部重试只处理 through 及以前、能重试的核心死信，其余留着', async () => {
  await dead(MAIL_JOB, emailChanged())
  const reset = await dead(MAIL_JOB, stripped())
  const cleanup = await dead('core:auth-cleanup', {})
  const plugin = await dead('plugin:a:job', {})
  const later = await dead('core:audit-log-cleanup', {})

  expect(await core.admin.retryAllFailedJobs(superadmin, plugin)).toEqual({ retried: 2, skipped: 1 })
  expect((await queued()).map((job) => job.name).sort()).toEqual(['core:auth-cleanup', MAIL_JOB])
  expect(await remaining()).toEqual([reset, plugin, later])
  expect(await audits()).toEqual([
    {
      action: 'job.deadLetter',
      subject: ['job', 0],
      actor: superadmin.uid,
      details: { action: 'retryAll', count: 2, skipped: 1 },
    },
  ])
  expect(await core.admin.retryAllFailedJobs(superadmin, cleanup)).toEqual({ retried: 0, skipped: 1 })
  expect(await audits()).toHaveLength(1)
})

test('前缀区分大小写：CORE: 开头的不算核心任务，不进列表、计数和最大编号，也不会被全部删除', async () => {
  const core1 = await dead(MAIL_JOB, emailChanged())
  const upper = await dead('CORE:mail', emailChanged())
  const mixed = await dead('Core:auth-cleanup', {})
  const page = await core.admin.listFailedJobs(superadmin.uid, { page: 1 })
  expect(page).toMatchObject({ total: 1, latestId: core1 })
  expect(page.items.map((item) => item.id)).toEqual([core1])
  expect((await core.admin.overview(superadmin.uid)).failedJobs).toBe(1)
  for (const id of [upper, mixed])
    await expect(core.admin.deleteFailedJob(superadmin, id)).rejects.toMatchObject({ code: 'dead_letter_not_found' })
  expect(await core.admin.retryAllFailedJobs(superadmin, mixed)).toEqual({ retried: 1, skipped: 0 })
  expect(await core.admin.deleteAllFailedJobs(superadmin, mixed)).toEqual({ deleted: 0 })
  expect(await remaining()).toEqual([upper, mixed])
})

test('全部删除只删 through 及以前的核心死信', async () => {
  await dead(MAIL_JOB, stripped())
  const plugin = await dead('plugin:a:job', {})
  const second = await dead('core:auth-cleanup', {})
  const later = await dead(MAIL_JOB, emailChanged())

  expect(await core.admin.deleteAllFailedJobs(superadmin, second)).toEqual({ deleted: 2 })
  expect(await remaining()).toEqual([plugin, later])
  expect(await core.admin.deleteAllFailedJobs(superadmin, second)).toEqual({ deleted: 0 })
  expect(await audits()).toEqual([
    {
      action: 'job.deadLetter',
      subject: ['job', 0],
      actor: superadmin.uid,
      details: { action: 'deleteAll', count: 2 },
    },
  ])
})
