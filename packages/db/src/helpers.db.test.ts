import { sql, type Generated, type Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  autoIncrementId,
  countRows,
  createTable,
  dialectOf,
  insertOrIgnore,
  insertReturningId,
  isUniqueViolation,
  toNumber,
} from './index.ts'
import { createTestDatabase, testDialect, type TestDatabase } from './testing.ts'

interface Item {
  id: Generated<number>
  name: string
  n: number
  alternate: string | null
}
interface Schema {
  items: Item
}
let database: TestDatabase<Schema>
let db: Kysely<Schema>
beforeAll(async () => {
  database = await createTestDatabase<Schema>()
  db = database.db
  await createTable(db, 'items')
    .$call(autoIncrementId(db))
    .addColumn('name', 'varchar(100)', (c) => c.notNull().unique())
    .addColumn('n', 'integer', (c) => c.notNull().check(sql`n >= 0`))
    .addColumn('alternate', 'varchar(100)', (c) => c.unique())
    .execute()
})
afterAll(async () => {
  await database?.cleanup()
})
beforeEach(async () => {
  await db.deleteFrom('items').execute()
})

const item = (name: string, n = 1) => ({ name, n, alternate: null })

test('dialectOf 能识别数据库和事务的方言', async () => {
  // MariaDB 与 MySQL 共用方言和驱动。
  const expected = testDialect() === 'mariadb' ? 'mysql' : testDialect()
  expect(dialectOf(db)).toBe(expected)
  await db.transaction().execute((trx) => {
    expect(dialectOf<Schema>(trx)).toBe(expected)
    return Promise.resolve()
  })
})

test('insertReturningId 在事务内外均返回安全整数 ID', async () => {
  const first = await insertReturningId(db, 'items', item('first'))
  expect(Number.isSafeInteger(first)).toBe(true)
  const second = await db
    .transaction()
    .execute((trx) => insertReturningId<Schema, 'items'>(trx, 'items', item('second')))
  expect(second).toBeGreaterThan(first)
  expect(await db.selectFrom('items').select('name').where('id', '=', first).executeTakeFirstOrThrow()).toEqual({
    name: 'first',
  })
})

test('insertOrIgnore 准确报告是否插入，保证事务内计数器正确', async () => {
  await db.transaction().execute(async (trx) => {
    expect(await insertOrIgnore<Schema, 'items'>(trx, 'items', item('counter', 0), ['name'])).toBe(true)
    for (const expected of [true, false]) {
      const inserted = await insertOrIgnore<Schema, 'items'>(trx, 'items', item('entry'), ['name'])
      expect(inserted).toBe(expected)
      if (inserted)
        await trx
          .updateTable('items')
          .set((eb) => ({ n: eb('n', '+', 1) }))
          .where('name', '=', 'counter')
          .execute()
    }
    expect(await insertOrIgnore<Schema, 'items'>(trx, 'items', item('entry'), ['name'])).toBe(false)
    // 冲突后 PostgreSQL 事务必须仍可继续使用。
    expect(await countRows(trx.selectFrom('items'))).toBe(2)
  })
  expect(await db.selectFrom('items').select('n').where('name', '=', 'counter').executeTakeFirstOrThrow()).toEqual({
    n: 1,
  })
})

test('insertOrIgnore 不吞掉 NOT NULL 错误', async () => {
  // 故意绕过类型约束，验证数据错误不会被当作重复键忽略。
  await expect(
    insertOrIgnore(db, 'items', { ...item('invalid'), n: null as unknown as number }, ['name']),
  ).rejects.toThrow()
  expect(await countRows(db.selectFrom('items'))).toBe(0)
})

test('仅忽略重复键错误，MySQL 按约定忽略任意唯一键冲突', async () => {
  await db
    .insertInto('items')
    .values({ ...item('first'), alternate: 'unique' })
    .execute()
  const insertion = insertOrIgnore(db, 'items', { ...item('second'), alternate: 'unique' }, ['name'])
  // MySQL 无法指定冲突列，会忽略任意唯一键冲突；PostgreSQL 和 SQLite 必须抛出其他唯一键的冲突错误。
  if (dialectOf(db) === 'mysql') expect(await insertion).toBe(false)
  else await expect(insertion).rejects.toThrow()
  expect(await countRows(db.selectFrom('items'))).toBe(1)
})

test('唯一文本列区分大小写，不受服务器默认排序规则影响', async () => {
  expect(await insertOrIgnore(db, 'items', item('Steve'), ['name'])).toBe(true)
  expect(await insertOrIgnore(db, 'items', item('steve'), ['name'])).toBe(true)
  expect(await countRows(db.selectFrom('items'))).toBe(2)
})

test('countRows 保留过滤条件并支持空结果，toNumber 能转换实际聚合结果', async () => {
  expect(await countRows(db.selectFrom('items'))).toBe(0)
  await db
    .insertInto('items')
    .values([item('a', 2), item('b', 3)])
    .execute()
  expect(await countRows(db.selectFrom('items').where('n', '>', 2))).toBe(1)
  const result = await db
    .selectFrom('items')
    .select([sql<string | number | bigint>`count(*)`.as('n'), sql<string | number | bigint>`sum(n)`.as('total')])
    .executeTakeFirstOrThrow()
  expect(toNumber(result.n)).toBe(2)
  expect(toNumber(result.total)).toBe(5)
})

test('insertOrIgnore 拒绝空的冲突列数组', async () => {
  await expect(insertOrIgnore(db, 'items', item('a'), [])).rejects.toThrow(/缺少冲突列/)
})

test('isUniqueViolation 只认唯一键和主键冲突，拒绝其他约束和非对象', async () => {
  const id = await insertReturningId(db, 'items', item('existing'))
  const cases = [
    [db.insertInto('items').values(item('existing')), true],
    [db.insertInto('items').values({ ...item('primary'), id }), true],
    [db.insertInto('items').values({ ...item('null'), n: null as unknown as number }), false],
    [db.insertInto('items').values(item('check', -1)), false],
  ] as const
  for (const [query, expected] of cases) {
    const error = await query.execute().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(isUniqueViolation(db, error)).toBe(expected)
  }
  for (const error of [new Error('普通错误'), null, undefined, '23505', 1062, false, {}])
    expect(isUniqueViolation(db, error)).toBe(false)
})
