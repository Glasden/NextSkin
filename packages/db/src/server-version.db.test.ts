import { afterAll, beforeAll, expect, test } from 'vitest'
import { databaseServerVersion } from './server-version.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

let database: TestDatabase<Record<string, never>>
beforeAll(async () => {
  database = await createTestDatabase()
})
afterAll(async () => {
  await database?.cleanup()
})
test('服务端版本在普通连接和事务中返回同一个非空版本', async () => {
  const version = await databaseServerVersion(database.db)
  expect(version).toMatch(/\d+\.\d+/)
  expect(await database.db.transaction().execute((tx) => databaseServerVersion(tx))).toBe(version)
})
