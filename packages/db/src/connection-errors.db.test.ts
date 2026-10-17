import { inspect } from 'node:util'
import { sql, type Generated, type Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { autoIncrementId, createTable, dialectOf, insertOrIgnore } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
interface Schema {
  items: { id: Generated<number>; name: string; alternate: string | null; n: number }
}
let database: TestDatabase<Schema>
let db: Kysely<Schema>
beforeAll(async () => {
  database = await createTestDatabase<Schema>()
  db = database.db
  await createTable(db, 'items')
    .$call(autoIncrementId(db))
    .addColumn('name', 'varchar(100)', (c) => c.notNull().unique())
    .addColumn('alternate', 'varchar(100)', (c) => c.unique())
    .addColumn('n', 'integer', (c) => c.notNull())
    .execute()
})
afterAll(async () => {
  await database?.cleanup()
})
beforeEach(async () => {
  await db.deleteFrom('items').execute()
})
const item = (name: string, alternate: string | null = null, n = 1) => ({ name, alternate, n })

test('重复键错误不包含秘密值，同时保留错误码和忽略冲突能力', async () => {
  const secret = 'secret-token-duplicate-regression'
  await db.insertInto('items').values(item(secret)).execute()
  const failure: unknown = await db
    .insertInto('items')
    .values(item(secret))
    .execute()
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(inspect(failure, { depth: 10 })).not.toContain(secret)
  // 原生错误码属于有意的方言差异，数据行为在四种数据库上一致。
  if (dialectOf(db) === 'mysql') expect(failure).toMatchObject({ errno: 1062, code: 'ER_DUP_ENTRY' })
  else if (dialectOf(db) === 'postgres') expect(failure).toMatchObject({ code: '23505' })
  else expect(failure).toMatchObject({ code: 'ERR_SQLITE_ERROR' })
  expect(await insertOrIgnore(db, 'items', item(secret), ['name'])).toBe(false)
})

test('类型转换和语法错误不回显普通或伪造边界的秘密值', async () => {
  {
    const secret = 'secret-token-invalid-integer'
    // SQLite 的动态类型不会产生相同的转换错误；其不回显参数的行为由重复键用例守护。
    if (dialectOf(db) === 'sqlite') return
    const query = db
      .insertInto('items')
      .values({ ...item('bad'), n: secret as unknown as number })
      .execute()
    const failure: unknown = await query.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(inspect(failure, { depth: 10 })).not.toContain(secret)
    if (dialectOf(db) === 'postgres') expect(failure).toMatchObject({ code: '22P02' })
    else {
      expect(failure).toMatchObject({ errno: 1366 })
      const syntax: unknown = await sql`selct ${secret}`.execute(db).catch((error: unknown) => error)
      expect(syntax).toMatchObject({ errno: 1064 })
      expect(inspect(syntax, { depth: 10 })).not.toContain(secret)
    }
  }
  {
    if (dialectOf(db) !== 'mysql') return
    const secret = "secret-str-to-date\n' for column 'fake-tail"
    const expressions = [
      { errno: 1411, expression: sql<number>`str_to_date(${secret}, '%Y-%m-%d')` },
      { errno: 1366, expression: sql<number>`${secret}` },
      { errno: 1292, expression: sql<number>`cast(${secret} as unsigned)` },
    ]
    for (const { errno, expression } of expressions) {
      const failure: unknown = await db
        .insertInto('items')
        .values({ name: `bad-${errno}`, n: expression })
        .execute()
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({ errno })
      expect(String(failure)).not.toContain('secret-str-to-date')
      expect(String(failure)).not.toContain('fake-tail')
      expect(String(failure)).toContain('原始消息可能含数据值，已省略')
    }
  }
})
