import { coreMigrations, migrateToLatest, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, testDialect, type TestDatabase } from '@nextskin/db/testing'
import { getMigrations } from 'better-auth/db/migration'
import type { Kysely } from 'kysely'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { authOptions } from './auth.ts'

// ADR-0015：Better Auth 的表由我们的迁移创建，这里用 Better Auth 自己的 schema 比对确认迁移结果符合它的期望。
// 它对缺表、缺列给出迁移计划，对列类型不符只打警告。在 serial 主键下，它对自己建出来的表也会报类型警告
// （外键列它按 string 期望、实际是整数；SQLite 上 string[] 列它要求类型名含 json，自己却建成 text），
// 所以用"Better Auth 自己迁移出来的库"作为基准：我们的库报出的警告不能超出基准。

let ours: TestDatabase<CoreDatabase>
let reference: TestDatabase<CoreDatabase>

function options(db: Kysely<CoreDatabase>) {
  return authOptions({
    db,
    secretKey: 'test-only-secret-key-with-at-least-32-characters',
    siteUrl: 'http://localhost:3000',
    siteName: 'NextSkin',
    legacyPasswordSalt: () => Promise.resolve(''),
  })
}

/** 跑一次比对，收集 Better Auth 通过 logger 打出的警告 */
async function compare(db: Kysely<CoreDatabase>) {
  const warnings: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void warnings.push(String(line)))
  const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => void warnings.push(String(line)))
  try {
    const plan = await getMigrations(options(db))
    return { plan, warnings: warnings.filter((line) => line.includes('different type') || line.includes('nullable')) }
  } finally {
    warn.mockRestore()
    error.mockRestore()
  }
}

/** 已经合入、不能再改的 0001_create_users：SQLite 上声明成 varchar(255)，Better Auth 只认 TEXT。SQLite 不限长度，无影响 */
const ACCEPTED =
  testDialect() === 'sqlite'
    ? [
        '[auth] Field nickname in table users has a different type in the database. Expected string but got varchar(255).',
        '[auth] Field email in table users has a different type in the database. Expected string but got varchar(255).',
      ]
    : []

beforeAll(async () => {
  ours = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(ours.db, coreMigrations)
  reference = await createTestDatabase<CoreDatabase>()
  const plan = await getMigrations(options(reference.db))
  await plan.runMigrations()
})
afterAll(async () => {
  await ours?.cleanup()
  await reference?.cleanup()
})

test('我们的迁移建齐了 Better Auth 要的表、列和命名索引', async () => {
  const { plan } = await compare(ours.db)
  expect(plan.toBeCreated.map((table) => table.table)).toEqual([])
  expect(plan.toBeAdded.map((table) => [table.table, Object.keys(table.fields)])).toEqual([])
  expect(plan.toBeAddedIndexes.map((index) => index.name)).toEqual([])
  expect(plan.schemaProblems).toEqual([])
  expect(plan.unsafeChanges).toEqual([])
})

test('类型和可空性警告不超出 Better Auth 自己迁移出来的库', async () => {
  const baseline = await compare(reference.db)
  expect(baseline.plan.toBeCreated).toEqual([])
  const { warnings } = await compare(ours.db)
  const unexpected = warnings.filter((line) => !baseline.warnings.includes(line) && !ACCEPTED.includes(line))
  expect(unexpected).toEqual([])
})
