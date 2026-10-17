import { afterAll, beforeAll, expect, test } from 'vitest'
import { coreMigrations } from './migrations/index.ts'
import { migrateToLatest } from './migrations.ts'
import type { CoreDatabase } from './schema.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { toIsoTimestamp } from './helpers.ts'
import { transactionWithRetry } from './transaction-retry.ts'

let database: TestDatabase<CoreDatabase>
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
})
afterAll(async () => database?.cleanup())

test('重试整个回调，失败尝试的写入回滚；其他错误及耗尽后的错误原样抛出', async () => {
  const failure = Object.assign(new Error('omitted'), { code: '40001' })
  let calls = 0
  const run = () =>
    transactionWithRetry(database.db, async (tx) => {
      calls++
      await tx
        .insertInto('settings')
        .values({ namespace: 'retry', key: 'one', value: 'true', updated_at: toIsoTimestamp(new Date()) })
        .execute()
      if (calls < 3) throw failure
      return 42
    })
  expect(await run()).toBe(42)
  expect(calls).toBe(3)
  expect(await database.db.selectFrom('settings').select('key').where('namespace', '=', 'retry').execute()).toEqual([
    { key: 'one' },
  ])
  calls = 0
  await expect(
    transactionWithRetry(
      database.db,
      () => {
        calls++
        return Promise.reject(failure)
      },
      { attempts: 2 },
    ),
  ).rejects.toBe(failure)
  expect(calls).toBe(2)
  const other = new Error('no retry')
  calls = 0
  await expect(
    transactionWithRetry(database.db, () => {
      calls++
      return Promise.reject(other)
    }),
  ).rejects.toBe(other)
  expect(calls).toBe(1)
  await expect(transactionWithRetry(database.db, () => Promise.resolve(0), { attempts: 0 })).rejects.toThrow(RangeError)
})
