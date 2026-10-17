import { type ColumnType, type Kysely } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  authBooleanType,
  authDateType,
  createTable,
  dialectOf,
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  writeAuthDate,
  type IsoTimestamp,
} from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

interface Schema {
  auth_values: { date: ColumnType<string | Date, string | Date>; flag: ColumnType<boolean | 0 | 1, boolean | 0 | 1> }
}
let database: TestDatabase<Schema>
let db: Kysely<Schema>
beforeAll(async () => {
  database = await createTestDatabase<Schema>()
  db = database.db
  await createTable(db, 'auth_values')
    .addColumn('date', authDateType(db), (c) => c.notNull())
    .addColumn('flag', authBooleanType(db), (c) => c.notNull())
    .execute()
})
afterAll(async () => database?.cleanup())

test('认证日期和布尔列符合 Better Auth 的类型约定', () => {
  // 与 get-migration.mjs 的 map / matchType 对齐：SQLite 的日期类型必须叫 date。
  const dialect = dialectOf(db)
  expect(authDateType(db).compile(db).sql).toBe(
    dialect === 'mysql' ? 'datetime(3)' : dialect === 'postgres' ? 'timestamptz(3)' : 'date',
  )
  expect(authBooleanType(db).compile(db).sql).toBe(dialect === 'sqlite' ? 'integer' : 'boolean')
})

test('认证日期往返保留 UTC 毫秒和超过二零三八年的时间点，布尔转换结果一致', async () => {
  for (const [index, value] of ['2026-01-01T00:00:00.123Z', '2040-02-29T23:59:59.999Z'].entries()) {
    const timestamp = toIsoTimestamp(new Date(value))
    const written = writeAuthDate(db, timestamp)
    // SQLite 不接受 Date；MySQL/PG 的原生日期列必须交给驱动写入 Date。
    expect(typeof written === 'string').toBe(dialectOf(db) === 'sqlite')
    await db
      .insertInto('auth_values')
      .values({ date: written, flag: dialectOf(db) === 'postgres' ? index === 1 : (index as 0 | 1) })
      .execute()
  }
  const rows = await db.selectFrom('auth_values').selectAll().orderBy('date').execute()
  expect(rows.map((row) => readAuthDate(row.date))).toEqual(['2026-01-01T00:00:00.123Z', '2040-02-29T23:59:59.999Z'])
  expect(rows.map((row) => readAuthBoolean(row.flag))).toEqual([false, true])
  // 驱动原始类型差异是刻意保留的 Better Auth 契约。
  for (const row of rows) {
    expect(row.date instanceof Date).toBe(dialectOf(db) !== 'sqlite')
    expect(typeof row.flag).toBe(dialectOf(db) === 'postgres' ? 'boolean' : 'number')
  }
})

test('认证转换接受合法值并拒绝错误类型和非法日期', () => {
  const value = '2026-01-01T00:00:00.000Z'
  expect(readAuthDate(value)).toBe(value)
  expect(readAuthDate(new Date(value))).toBe(value)
  for (const invalid of [
    null,
    undefined,
    0,
    {},
    new Date(NaN),
    new Date('+010000-01-01T00:00:00.000Z'),
    '2026-02-30T00:00:00.000Z',
    '2026-01-01t00:00:00.000Z',
    value + '\n',
    '2026-01-01T00:00:00Z',
  ]) {
    expect(() => readAuthDate(invalid)).toThrow()
  }
  expect(() => writeAuthDate(db, 'bad' as IsoTimestamp)).toThrow()
  for (const [input, output] of [
    [true, true],
    [false, false],
    [1, true],
    [0, false],
  ] as const)
    expect(readAuthBoolean(input)).toBe(output)
  for (const invalid of [null, undefined, '0', '1', 2, -1, NaN, {}])
    expect(() => readAuthBoolean(invalid)).toThrow(TypeError)
})
