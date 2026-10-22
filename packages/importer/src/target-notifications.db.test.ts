import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { clearBusinessData, inspectTarget } from './target.ts'

let database: TestDatabase<CoreDatabase>
const at = toIsoTimestamp(new Date('2030-01-01T00:00:00Z'))
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
})
afterAll(async () => database?.cleanup())
test('通知、群发和永久键都算新站业务数据，导入按外键顺序全部清空', async () => {
  const { db } = database
  const uid = await insertReturningId(db, 'users', {
    nickname: 'user',
    email: 'user@example.test',
    email_verified: true,
    created_at: writeAuthDate(db, at),
    updated_at: writeAuthDate(db, at),
  })
  const id = await insertReturningId(db, 'notification_broadcasts', {
    sender_id: uid,
    audience: 'specific',
    title: 'x',
    body: '',
    through_uid: uid,
    status: 'sent',
    created_at: at,
    finished_at: at,
  })
  await db
    .insertInto('notifications')
    .values({ user_id: uid, type: 'message', broadcast_id: id, created_at: at })
    .execute()
  await db
    .insertInto('plugin_notification_keys')
    .values({ plugin_id: 'example', plugin_key: 'forever', user_id: uid, fingerprint: 'a'.repeat(64), created_at: at })
    .execute()
  expect(await inspectTarget(db)).toMatchObject({ hasData: true, newData: { other: 3 } })
  await db.transaction().execute((tx) => clearBusinessData(tx))
  for (const table of ['notifications', 'notification_broadcasts', 'plugin_notification_keys', 'users'] as const)
    expect(await db.selectFrom(table).selectAll().execute()).toEqual([])
  expect(await inspectTarget(db)).toMatchObject({ hasData: false })
})
