import { afterAll, beforeAll, expect, test } from 'vitest'
import { containsInsensitive, createTable } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

let database: TestDatabase<{ names: { name: string } }>
beforeAll(async () => {
  database = await createTestDatabase()
  await createTable(database.db, 'names')
    .addColumn('name', 'varchar(100)', (c) => c.notNull())
    .execute()
  await database.db
    .insertInto('names')
    .values([
      { name: 'AbCd' },
      { name: '100%' },
      { name: 'a_b' },
      { name: 'a!b' },
      { name: 'a\\b' },
      { name: '中文材质' },
      { name: 'Är' },
    ])
    .execute()
})
afterAll(async () => database?.cleanup())
// SQLite lower() 只处理 ASCII；不承诺所有数据库有相同的 Unicode 大小写折叠。
test.each([
  ['bc', ['AbCd']],
  ['BC', ['AbCd']],
  ['%', ['100%']],
  ['_', ['a_b']],
  ['!', ['a!b']],
  ['\\', ['a\\b']],
  ['文材', ['中文材质']],
  ['Ä', ['Är']],
])('包含查询把 %s 当作字面子串', async (query, expected) => {
  const rows = await database.db.selectFrom('names').select('name').where(containsInsensitive('name', query)).execute()
  expect(rows.map((row) => row.name)).toEqual(expected)
})
test('空字符串匹配所有非空值', async () => {
  expect(
    await database.db.selectFrom('names').select('name').where(containsInsensitive('name', '')).execute(),
  ).toHaveLength(7)
})
