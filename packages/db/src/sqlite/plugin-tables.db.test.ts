import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { dropPluginTables, listTablesWithPrefix } from './plugin-query.ts'
import { createTestDatabase, type TestDatabase } from '../testing.ts'

let database: TestDatabase<object>
beforeAll(async () => {
  database = await createTestDatabase<object>()
})
afterAll(() => database.cleanup())

test('按前缀列出表：前缀里的下划线不当通配符，大小写按原样', async () => {
  const { db } = database
  const names = ['p_a_b__codes', 'p_a_b__logs', 'p_axb__codes', 'p_a_b_c__codes', 'p_a__b_codes']
  for (const name of names) await sql`create table ${sql.id(name)} (id integer primary key)`.execute(db)
  expect((await listTablesWithPrefix(db, 'p_a_b__')).sort()).toEqual(['p_a_b__codes', 'p_a_b__logs'])
  expect(await listTablesWithPrefix(db, 'p_a__')).toEqual(['p_a__b_codes'])
  expect(await listTablesWithPrefix(db, 'p_missing__')).toEqual([])
  await dropPluginTables(db, names)
  expect(await listTablesWithPrefix(db, 'p_')).toEqual([])
})
