import { coreMigrations, migrateToLatest, toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import type { Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  claimJob,
  completeJob,
  failJob,
  FAILED_JOB_RETENTION_DAYS,
  findDueJobs,
  insertJob,
  jobStatistics,
  jobSummary,
  rescheduleJob,
} from './store.ts'

const now = toIsoTimestamp(new Date('2040-03-31T12:00:00.000Z'))
const later = toIsoTimestamp(new Date('2040-03-31T12:01:00.000Z'))
const expired = toIsoTimestamp(new Date('2040-03-31T12:02:00.000Z'))
let database: TestDatabase<CoreDatabase>
let db: Kysely<CoreDatabase>
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  db = database.db
  await migrateToLatest(db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db.deleteFrom('jobs').execute()
  await db.deleteFrom('failed_jobs').execute()
})

async function enqueue(dedupeKey?: string) {
  await insertJob(db, { name: 'core:test', payload: { value: 1 }, runAt: now, dedupeKey }, now)
  return (await db.selectFrom('jobs').select('id').orderBy('id', 'desc').executeTakeFirstOrThrow()).id
}
async function claimed() {
  const id = await enqueue('same')
  return (await claimJob(db, { id, now, leaseUntil: later }))!
}

test.each(['complete', 'fail'] as const)('同键去重，%s 后可以重新入队', async (finish) => {
  const lease = await claimed()
  const job = { name: 'core:test', payload: null, runAt: now, dedupeKey: 'same' }
  expect(await insertJob(db, job, now)).toBe(false)
  expect(finish === 'complete' ? await completeJob(db, lease) : await failJob(db, lease, { error: '失败', now })).toBe(
    true,
  )
  expect(await insertJob(db, job, now)).toBe(true)
  expect(await insertJob(db, { ...job, name: 'other' }, now)).toBe(true)
  expect(await insertJob(db, { ...job, dedupeKey: null }, now)).toBe(true)
  expect(await insertJob(db, { ...job, dedupeKey: null }, now)).toBe(true)
})

test('只取指定名称的到期任务，按时间和 id 排序并限制条数', async () => {
  await insertJob(db, { name: 'core:test', payload: null, runAt: later }, now)
  await insertJob(db, { name: 'other', payload: null, runAt: now }, now)
  const first = await enqueue()
  const second = await enqueue()
  const early = toIsoTimestamp(new Date(Date.parse(now) - 1000))
  await insertJob(db, { name: 'core:test', payload: null, runAt: early }, now)
  const earliest = (await db.selectFrom('jobs').select('id').where('run_at', '=', early).executeTakeFirstOrThrow()).id
  expect(await findDueJobs(db, { names: ['core:test'], now, limit: 2 })).toEqual([
    { id: earliest, name: 'core:test' },
    { id: first, name: 'core:test' },
  ])
  expect(await findDueJobs(db, { names: ['core:test'], now, limit: 5 })).toHaveLength(3)
  expect(second).toBeGreaterThan(first)
  expect(await findDueJobs(db, { names: [], now, limit: 5 })).toEqual([])
})

test('认领增加次数，租约到期后换发标识，旧租约不能收尾或改动数据', async () => {
  const lease = await claimed()
  expect(lease).toMatchObject({ name: 'core:test', payload: { value: 1 }, attempts: 1, createdAt: now })
  expect(lease.leaseId).toMatch(/^[0-9a-f-]{36}$/)
  expect(await claimJob(db, { id: lease.id, now, leaseUntil: later })).toBeNull()
  const next = (await claimJob(db, { id: lease.id, now: expired, leaseUntil: expired }))!
  expect(next.attempts).toBe(2)
  expect(next.leaseId).not.toBe(lease.leaseId)
  const before = await db.selectFrom('jobs').selectAll().execute()
  expect(await completeJob(db, lease)).toBe(false)
  expect(await rescheduleJob(db, lease, { runAt: expired, error: '旧租约' })).toBe(false)
  expect(await failJob(db, lease, { error: '旧租约', now: expired })).toBe(false)
  expect(await db.selectFrom('jobs').selectAll().execute()).toEqual(before)
  expect(await db.selectFrom('failed_jobs').selectAll().execute()).toEqual([])
})

test('并发独立事务认领同一任务恰好一次成功', async () => {
  const id = await enqueue()
  const claims = await Promise.all(Array.from({ length: 8 }, () => claimJob(db, { id, now, leaseUntil: later })))
  expect(claims.filter(Boolean)).toHaveLength(1)
  expect(claims.find(Boolean)!.attempts).toBe(1)
})

test('重新排期更新错误并清空租约，到期后可以再次认领', async () => {
  const lease = await claimed()
  expect(await rescheduleJob(db, lease, { runAt: later, error: '发送失败' })).toBe(true)
  expect(await db.selectFrom('jobs').select(['run_at', 'lease_id', 'last_error']).executeTakeFirstOrThrow()).toEqual({
    run_at: later,
    lease_id: null,
    last_error: '发送失败',
  })
  expect(await claimJob(db, { id: lease.id, now, leaseUntil: later })).toBeNull()
  expect((await claimJob(db, { id: lease.id, now: later, leaseUntil: expired }))!.attempts).toBe(2)
})

test('死信保留原任务信息、替换载荷，严格清理早于 30 天的记录', async () => {
  expect(FAILED_JOB_RETENTION_DAYS).toBe(30)
  const cutoff = Date.parse(now) - FAILED_JOB_RETENTION_DAYS * 86_400_000
  const dead = { name: 'old', payload: '{}', dedupe_key: null, attempts: 5, last_error: null, created_at: now }
  await db
    .insertInto('failed_jobs')
    .values([-1, 0, 1].map((offset) => ({ ...dead, failed_at: toIsoTimestamp(new Date(cutoff + offset)) })))
    .execute()
  const lease = await claimed()
  expect(await failJob(db, lease, { error: '发送失败', now, payload: { redacted: true } })).toBe(true)
  expect(await db.selectFrom('jobs').selectAll().execute()).toEqual([])
  const rows = await db.selectFrom('failed_jobs').selectAll().orderBy('id').execute()
  expect(rows).toHaveLength(3)
  expect(rows[0]!.failed_at).toBe(toIsoTimestamp(new Date(cutoff)))
  const { id: failedId, ...failed } = rows[2]!
  expect(failedId).toBeGreaterThan(0)
  expect(failed).toEqual({
    name: lease.name,
    payload: '{"redacted":true}',
    dedupe_key: 'same',
    attempts: 1,
    last_error: '发送失败',
    created_at: now,
    failed_at: now,
  })
})

test('省略替换载荷时原样保留，显式 null 时写入 JSON null', async () => {
  const first = await claimed()
  expect(await failJob(db, first, { error: '失败', now })).toBe(true)
  const second = await claimed()
  expect(await failJob(db, second, { error: '失败', now, payload: null })).toBe(true)
  expect(
    (await db.selectFrom('failed_jobs').select('payload').orderBy('id').execute()).map((row) => row.payload),
  ).toEqual(['{"value":1}', 'null'])
})

test('并发移入死信最多写入一条记录', async () => {
  const lease = await claimed()
  const results = await Promise.all(Array.from({ length: 4 }, () => failJob(db, lease, { error: '失败', now })))
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(await db.selectFrom('failed_jobs').select('id').execute()).toHaveLength(1)
})

test('两种失败路径的错误按码位截断，不切开代理对', async () => {
  const error = '错'.repeat(499) + '😀' + '尾'
  const lease = await claimed()
  await rescheduleJob(db, lease, { runAt: now, error })
  expect((await db.selectFrom('jobs').select('last_error').executeTakeFirstOrThrow()).last_error).toBe(
    '错'.repeat(499) + '😀',
  )
  const next = (await claimJob(db, { id: lease.id, now, leaseUntil: later }))!
  await failJob(db, next, { error, now })
  expect((await db.selectFrom('failed_jobs').select('last_error').executeTakeFirstOrThrow()).last_error).toBe(
    '错'.repeat(499) + '😀',
  )
})

test.each([
  { name: '' },
  { name: 'a'.repeat(129) },
  { name: 'core:test ' },
  { dedupeKey: '' },
  { dedupeKey: 'a'.repeat(256) },
  // MySQL 会把它和 'request-42' 当成同一个键，PG 和 SQLite 不会
  { dedupeKey: 'request-42 ' },
  { dedupeKey: ' request-42' },
  // PostgreSQL 存不了 NUL；不成对的代理项写进数据库变成 U+FFFD，'\ud800' 和 '\ud801' 会被当成同一个键
  { dedupeKey: 'a\u0000b' },
  { dedupeKey: '\ud800' },
  { dedupeKey: 'a\udc00' },
])('非法入队参数抛 RangeError：%j', async (invalid) => {
  await expect(insertJob(db, { name: 'core:test', payload: {}, runAt: now, ...invalid }, now)).rejects.toThrow(
    RangeError,
  )
  expect(await db.selectFrom('jobs').selectAll().execute()).toEqual([])
})

test('码位长度的上限可以入队', async () => {
  expect(
    await insertJob(db, { name: '😀'.repeat(128), dedupeKey: '😀'.repeat(255), payload: {}, runAt: now }, now),
  ).toBe(true)
})

test('入队、认领、死信操作沿用调用方事务并随其回滚', async () => {
  await expect(
    transactionWithRetry(db, async (tx) => {
      await insertJob(tx, { name: 'core:test', payload: {}, runAt: now }, now)
      const [job] = await findDueJobs(tx, { names: ['core:test'], now, limit: 1 })
      const lease = (await claimJob(tx, { id: job!.id, now, leaseUntil: later }))!
      await failJob(tx, lease, { error: '失败', now })
      throw new Error('业务回滚')
    }),
  ).rejects.toThrow('业务回滚')
  expect(await db.selectFrom('jobs').selectAll().execute()).toEqual([])
  expect(await db.selectFrom('failed_jobs').selectAll().execute()).toEqual([])
})

test('诊断的统计：排队总数、到期最早的时间，只数核心死信；按名字的排队数、死信数和最近一条错误', async () => {
  await insertJob(db, { name: 'core:test', payload: {}, runAt: later }, now)
  await insertJob(db, { name: 'core:test', payload: {}, runAt: now }, now)
  await insertJob(db, { name: 'plugin:demo:job:x', payload: {}, runAt: expired }, now)
  const dead = { payload: '{}', dedupe_key: null, attempts: 3, created_at: now }
  await db
    .insertInto('failed_jobs')
    .values([
      { ...dead, name: 'core:test', last_error: '旧的错误', failed_at: now },
      { ...dead, name: 'core:test', last_error: '新的错误', failed_at: later },
      { ...dead, name: 'plugin:demo:job:x', last_error: null, failed_at: now },
    ])
    .execute()
  expect(await jobSummary(db, later)).toEqual({ queued: 3, oldestDueAt: now, deadLetters: 2 })
  expect(await jobSummary(db, toIsoTimestamp(new Date('2040-03-31T11:00:00.000Z')))).toMatchObject({
    oldestDueAt: null,
  })
  expect(await jobStatistics(db)).toEqual([
    { name: 'core:test', queued: 2, deadLetters: 2, lastError: '新的错误' },
    { name: 'plugin:demo:job:x', queued: 1, deadLetters: 1, lastError: null },
  ])
})
