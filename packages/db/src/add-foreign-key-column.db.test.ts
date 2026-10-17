import { type Kysely } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { addForeignKeyColumn, createTable, dialectOf } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

// 标识符包含引号和保留字，确保 DDL 经过 Kysely 转义。
const parent = 'parent"`table'
const child = 'child"`table'
const foreignColumn = 'parent"`id'
interface Schema {
  'parent"`table': { id: number }
  'child"`table': { id: number; 'parent"`id': import('kysely').ColumnType<number | null, number | null | undefined> }
}
let database: TestDatabase<Schema>
let db: Kysely<Schema>
beforeAll(async () => {
  database = await createTestDatabase<Schema>()
  db = database.db
})
afterAll(async () => database?.cleanup())

for (const onDelete of ['cascade', 'set null', 'restrict', 'no action'] as const) {
  test(`添加可空整数外键列后拒绝悬空引用，删除行为为 ${onDelete}`, async () => {
    await createTable(db, parent)
      .addColumn('id', 'integer', (c) => c.primaryKey())
      .execute()
    await createTable(db, child)
      .addColumn('id', 'integer', (c) => c.primaryKey())
      .execute()
    try {
      // 添加列之前已有行；SQLite 必须以 NULL 回填。
      await db.insertInto(child).values({ id: 0 }).execute()
      const add = async (executor: Kysely<Schema>) =>
        addForeignKeyColumn(executor, {
          table: child,
          column: foreignColumn,
          references: { table: parent, column: 'id' },
          onDelete,
          constraintName: 'fk"`parent',
        })
      // SQLite/PG 迁移在事务上执行；MySQL DDL 隐式提交，直接使用数据库实例。
      if (dialectOf(db) === 'mysql') await add(db)
      else await db.transaction().execute(add)
      expect(await db.selectFrom(child).selectAll().execute()).toEqual([{ id: 0, [foreignColumn]: null }])
      await expect(
        db
          .insertInto(child)
          .values({ id: 1, [foreignColumn]: 999 })
          .execute(),
      ).rejects.toThrow()
      await db.insertInto(parent).values({ id: 1 }).execute()
      await db
        .insertInto(child)
        .values({ id: 1, [foreignColumn]: 1 })
        .execute()
      if (onDelete === 'restrict' || onDelete === 'no action') {
        await expect(db.deleteFrom(parent).where('id', '=', 1).execute()).rejects.toThrow()
        expect(await db.selectFrom(parent).selectAll().execute()).toEqual([{ id: 1 }])
        expect(await db.selectFrom(child).selectAll().where('id', '=', 1).execute()).toEqual([
          { id: 1, [foreignColumn]: 1 },
        ])
      } else {
        await db.deleteFrom(parent).where('id', '=', 1).execute()
        expect(await db.selectFrom(child).selectAll().where('id', '=', 1).execute()).toEqual(
          onDelete === 'cascade' ? [] : [{ id: 1, [foreignColumn]: null }],
        )
      }
    } finally {
      await db.schema.dropTable(child).execute()
      await db.schema.dropTable(parent).execute()
    }
  })
}
