import { sql, type Generated, type Kysely } from 'kysely'
import { afterAll, beforeAll, expect, expectTypeOf, test } from 'vitest'
import { createTable, longTextType, switchColumn, type SwitchValue } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

interface Schema {
  switches: { is_on: Generated<SwitchValue>; is_off: Generated<SwitchValue>; required: SwitchValue }
  payloads: { value: string }
}
let database: TestDatabase<Schema>
let db: Kysely<Schema>
beforeAll(async () => {
  database = await createTestDatabase<Schema>()
  db = database.db
  await createTable(db, 'switches')
    .$call(switchColumn(db, 'is_on', { defaultValue: 1 }))
    .$call(switchColumn(db, 'is_off', { defaultValue: 0 }))
    .$call(switchColumn(db, 'required'))
    .execute()
  await createTable(db, 'payloads')
    .addColumn('value', longTextType(db), (c) => c.notNull())
    .execute()
})
afterAll(async () => database?.cleanup())

test('开关类型只接受零和一，默认值与读回值都是数字', async () => {
  expectTypeOf<SwitchValue>().toEqualTypeOf<0 | 1>()
  await db.insertInto('switches').values({ required: 0 }).execute()
  await db.insertInto('switches').values({ is_on: 0, is_off: 1, required: 1 }).execute()
  expect(await db.selectFrom('switches').selectAll().orderBy('required').execute()).toEqual([
    { is_on: 1, is_off: 0, required: 0 },
    { is_on: 0, is_off: 1, required: 1 },
  ])
})

test.each([2, -1, null])('开关列拒绝非法值 %j', async (value) => {
  await expect(sql`insert into switches (required) values (${value})`.execute(db)).rejects.toThrow()
})

test('长文本列无损存取七万字节的字符串', async () => {
  const value = '汉'.repeat(23_333) + '!'
  expect(Buffer.byteLength(value)).toBe(70_000)
  await db.insertInto('payloads').values({ value }).execute()
  expect((await db.selectFrom('payloads').selectAll().executeTakeFirstOrThrow()).value).toBe(value)
})
