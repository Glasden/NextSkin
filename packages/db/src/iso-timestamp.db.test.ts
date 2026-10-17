import { sql, type Kysely, type OperationNodeSource } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, expectTypeOf, test } from 'vitest'
import {
  createTable,
  dialectOf,
  isIsoTimestamp,
  isoTimestampColumn,
  toIsoTimestamp,
  type IsoTimestamp,
} from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

interface Schema {
  timestamps: { value: IsoTimestamp; optional: IsoTimestamp | null }
}
let database: TestDatabase<Schema>
let db: Kysely<Schema>
let check: OperationNodeSource
beforeAll(async () => {
  database = await createTestDatabase<Schema>()
  db = database.db
  const table = createTable(db, 'timestamps')
    .$call(isoTimestampColumn(db, 'value'))
    .$call(isoTimestampColumn(db, 'optional', { nullable: true }))
  check = { toOperationNode: () => table.toOperationNode().columns[0]!.check!.expression }
  await table.execute()
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db.deleteFrom('timestamps').execute()
})

test('ISO 时间品牌拒绝普通字符串，校验后收窄类型', () => {
  expectTypeOf<string>().not.toExtend<IsoTimestamp>()
  expectTypeOf(toIsoTimestamp(new Date())).toEqualTypeOf<IsoTimestamp>()
  const value: string = '2026-01-01T00:00:00.000Z'
  if (isIsoTimestamp(value)) expectTypeOf(value).toEqualTypeOf<IsoTimestamp>()
})

test('日期转换拒绝无效日期和超出四位数的年份，接受边界年份', () => {
  for (const value of ['0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
    expect(toIsoTimestamp(new Date(value))).toBe(value)
    expect(isIsoTimestamp(value)).toBe(true)
  }
  for (const value of [
    new Date(NaN),
    new Date('-000001-01-01T00:00:00.000Z'),
    new Date('+010000-01-01T00:00:00.000Z'),
  ]) {
    expect(() => toIsoTimestamp(value)).toThrow(RangeError)
  }
  for (const value of ['2026-02-30T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-01-01T24:00:00.000Z']) {
    expect(isIsoTimestamp(value)).toBe(false)
  }
})

const invalid = [
  '2026-01-01t00:00:00.000Z',
  '2026-01-01T00:00:00.000z',
  '202x-01-01T00:00:00.000Z',
  '２０２６-01-01T00:00:00.000Z',
  '2026-01-01 00:00:00.000Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00.000\n',
  '2026-01-01T00:00:00.000ZZ',
  '2026-01-01T00:00:00.000Z\0hidden',
  '',
]
test.each(invalid)('ISO 时间列拒绝格式错误的值 %j', async (value) => {
  expect(isIsoTimestamp(value)).toBe(false)
  // 故意绕过品牌以验证数据库兜底；超长值也可能先被 varchar(24) 拒绝。
  await expect(
    db
      .insertInto('timestamps')
      .values({ value: value as IsoTimestamp, optional: null })
      .execute(),
  ).rejects.toThrow()
  await expect(
    db
      .insertInto('timestamps')
      .values({ value: toIsoTimestamp(new Date()), optional: value as IsoTimestamp })
      .execute(),
  ).rejects.toThrow()
})

test('ISO 时间列默认非空，可空列允许 NULL，字符串排序与时间排序一致', async () => {
  await expect(sql`insert into timestamps (value) values (null)`.execute(db)).rejects.toThrow()
  const values = [
    '2026-01-01T00:00:00.001Z',
    '2000-02-29T12:00:00.000Z',
    '0000-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z',
    '2026-01-01T00:00:00.000Z',
    '2025-12-31T23:59:59.999Z',
  ].map((value) => toIsoTimestamp(new Date(value)))
  for (const value of values) await db.insertInto('timestamps').values({ value, optional: null }).execute()
  expect(await db.selectFrom('timestamps').selectAll().orderBy('value').execute()).toEqual(
    [...values]
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
      .map((value) => ({ value, optional: null })),
  )
})

test('ISO CHECK 本身拒绝末尾换行、非数字和所有错误长度', async () => {
  // PG 在文本解码阶段拒绝 NUL，早于 CHECK；插入测试已覆盖该输入。
  for (const value of [...invalid.filter((value) => !value.includes('\0')), '2026-01-01T00:00:00.000Z\n']) {
    // 在派生表上直接执行同一个 CHECK 表达式，输入不先经过 varchar 的截断或长度拒绝。
    const {
      rows: [row],
    } = await sql<{ accepted: boolean | number }>`
      select ${check} as accepted from (select ${value} as value) as input`.execute(db)
    expect(Number(row?.accepted), value).toBe(0)
  }
})

test('末尾换行在应用层被拒绝，MySQL 的列宽转换会在 CHECK 前截断它', async () => {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const value = timestamp + '\n'
  expect(isIsoTimestamp(value)).toBe(false)
  const insert = db
    .insertInto('timestamps')
    .values({ value: value as IsoTimestamp, optional: null })
    .execute()
  // MySQL/MariaDB 对超出 varchar 宽度的尾部空白仅警告并截断，即使启用了严格模式。
  // CHECK 只能验证转换后的存储值，不能拒绝已经丢失的原始后缀。
  if (dialectOf(db) === 'mysql') {
    await insert
    expect(
      await db
        .selectFrom('timestamps')
        .selectAll()
        .where('value', '=', timestamp as IsoTimestamp)
        .execute(),
    ).toEqual([{ value: timestamp, optional: null }])
    await db
      .deleteFrom('timestamps')
      .where('value', '=', timestamp as IsoTimestamp)
      .execute()
  } else await expect(insert).rejects.toThrow()
})

test('MySQL 与 MariaDB 的正则显式区分大小写，长度检查补上美元锚点的末尾换行特例', async () => {
  if (dialectOf(db) !== 'mysql') return
  const pattern = '(?-i)^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  for (const [value, matched, accepted] of [
    ['2026-01-01T00:00:00.000Z', 1, 1],
    ['2026-01-01t00:00:00.000Z', 0, 0],
    ['2026-01-01T00:00:00.000z', 0, 0],
    ['2026-01-01T00:00:00.000Z\n', 1, 0],
  ] as const) {
    // 即使操作数使用不区分大小写的排序规则，也必须服从 (?-i)。
    const {
      rows: [row],
    } = await sql<{ matched: number; accepted: number }>`
      select value regexp ${pattern} as matched, ${check} as accepted
      from (select cast(${value} as char charset utf8mb4) collate utf8mb4_general_ci as value) as input`.execute(db)
    expect(row).toEqual({ matched, accepted })
  }
})
