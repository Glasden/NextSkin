import { coreMigrations, migrateToLatest, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createSettingQueries } from '../settings/queries.ts'
import { createAuditCleanup } from './cleanup.ts'

let database: TestDatabase<CoreDatabase>
const db = () => database.db
const clock = new Date('2030-02-01T00:00:00Z')
const iso = (days: number) => toIsoTimestamp(new Date(clock.getTime() + days * 86_400_000))
const entry = (days: number) => ({
  actor_type: 'system' as const,
  actor_user_id: null,
  actor_plugin_id: null,
  action: 'test',
  subject_type: 'test',
  subject_id: 0,
  details: '{}',
  ip: null,
  created_at: iso(days),
})
const run = (signal = new AbortController().signal) =>
  createAuditCleanup({
    db: db(),
    settings: createSettingQueries(db(), 'test-secret-with-at-least-32-characters'),
    now: () => clock,
  }).run({ jobId: 0, payload: {}, attempt: 1, signal })
async function retention(days: number) {
  await db()
    .insertInto('settings')
    .values({ namespace: 'core', key: 'audit.retentionDays', value: JSON.stringify(days), updated_at: iso(0) })
    .execute()
}
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db().deleteFrom('audit_logs').execute()
  await db().deleteFrom('settings').execute()
})

test('默认零永久保留；保留期外删除，截止时刻及期内保留', async () => {
  await db()
    .insertInto('audit_logs')
    .values([entry(-31), entry(-30), entry(-1)])
    .execute()
  await run()
  expect(await db().selectFrom('audit_logs').select('id').execute()).toHaveLength(3)
  await retention(30)
  await run()
  expect(
    (await db().selectFrom('audit_logs').select('created_at').orderBy('id').execute()).map((row) => row.created_at),
  ).toEqual([iso(-30), iso(-1)])
})

test('分批删除超过一千条记录，取消时停止', async () => {
  await retention(1)
  for (let i = 0; i < 11; i++)
    await db()
      .insertInto('audit_logs')
      .values(Array.from({ length: 100 }, () => entry(-2)))
      .execute()
  const controller = new AbortController()
  controller.abort()
  await expect(run(controller.signal)).rejects.toThrow()
  expect(await db().selectFrom('audit_logs').select('id').execute()).toHaveLength(1100)
  await run()
  expect(await db().selectFrom('audit_logs').select('id').execute()).toEqual([])
})

test('一批里遇到期内记录就停止，后续批次不继续扫描', async () => {
  await retention(1)
  await db().insertInto('audit_logs').values(entry(0)).execute()
  for (let i = 0; i < 10; i++)
    await db()
      .insertInto('audit_logs')
      .values(Array.from({ length: 100 }, () => entry(-2)))
      .execute()
  await run()
  expect(
    (await db().selectFrom('audit_logs').select('created_at').orderBy('id').execute()).map((row) => row.created_at),
  ).toEqual([iso(0), iso(-2)])
})
