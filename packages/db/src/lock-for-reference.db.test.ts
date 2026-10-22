import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createTable, lockForReference } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

interface Schema {
  parents: { id: number; kind: string }
  children: { parent_id: number; note: string }
}
let database: TestDatabase<Schema>
let db: Kysely<Schema>
beforeAll(async () => {
  database = await createTestDatabase<Schema>()
  db = database.db
  await createTable(db, 'parents')
    .addColumn('id', 'integer', (c) => c.primaryKey())
    .addColumn('kind', 'varchar(20)', (c) => c.notNull())
    .execute()
  await createTable(db, 'children')
    .addColumn('parent_id', 'integer', (c) => c.notNull())
    .addColumn('note', 'varchar(20)', (c) => c.notNull())
    .addForeignKeyConstraint('children_parent', ['parent_id'], 'parents', ['id'], (c) => c.onDelete('cascade'))
    .execute()
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db.deleteFrom('children').execute()
  await db.deleteFrom('parents').execute()
  await db
    .insertInto('parents')
    .values([1, 2, 3].map((id) => ({ id, kind: 'a' })))
    .execute()
})

const insertChildren = (executor: Kysely<Schema>) =>
  executor
    .insertInto('children')
    .columns(['parent_id', 'note'])
    .expression(
      lockForReference(
        executor,
        executor
          .selectFrom('parents')
          .select(['id as parent_id', sql<string>`${'hello'}`.as('note')])
          .where('kind', '=', 'a')
          .orderBy('id'),
        'parents',
      ),
    )
    .executeTakeFirstOrThrow()

test('INSERT SELECT 碰上还没提交的删除，等删除提交后跳过删掉的行，不报外键错误', async () => {
  const deleted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const deleting = db.transaction().execute(async (trx) => {
    await trx.deleteFrom('parents').where('id', '=', 2).execute()
    deleted.resolve()
    await release.promise
  })
  await deleted.promise
  // SQLite 的写事务排队，服务器库在源查询的锁上等删除提交；两种情况都要先放行删除。
  const inserting = db.transaction().execute(insertChildren)
  setTimeout(release.resolve, 300)
  await deleting
  const result = await inserting
  expect(Number(result.numInsertedOrUpdatedRows)).toBe(2)
  expect(await db.selectFrom('children').select('parent_id').orderBy('parent_id').execute()).toEqual([
    { parent_id: 1 },
    { parent_id: 3 },
  ])
})

test('源查询带着锁也能和其他条件、排序一起用，没有并发时照常写入', async () => {
  await db.updateTable('parents').set({ kind: 'b' }).where('id', '=', 3).execute()
  const result = await db.transaction().execute(insertChildren)
  expect(Number(result.numInsertedOrUpdatedRows)).toBe(2)
})
