import { sql, type Generated, type Kysely, type KyselyPlugin } from 'kysely'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { autoIncrementId, createTable, dialectOf, insertReturningId, syncAutoIncrement } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

interface Schema {
  imported: { id: Generated<number>; name: string }
  empty_import: { key: Generated<number>; name: string }
  used_sequence: { id: Generated<number>; n: number }
  sequence: { id: Generated<number>; n: number }
}
let database: TestDatabase<Schema>
let db: Kysely<Schema>
beforeAll(async () => {
  database = await createTestDatabase<Schema>()
  db = database.db
  await createTable(db, 'imported')
    .$call(autoIncrementId(db))
    .addColumn('name', 'varchar(100)', (c) => c.notNull())
    .execute()
  await createTable(db, 'empty_import')
    .$call(autoIncrementId(db, 'key'))
    .addColumn('name', 'varchar(100)', (c) => c.notNull())
    .execute()
  await createTable(db, 'used_sequence').$call(autoIncrementId(db)).addColumn('n', 'integer').execute()
  await createTable(db, 'sequence').$call(autoIncrementId(db)).addColumn('n', 'integer').execute()
})
afterAll(async () => {
  await database?.cleanup()
})

test('显式导入 ID 后，syncAutoIncrement 保证各数据库继续递增', async () => {
  await db
    .insertInto('imported')
    .values([
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
      { id: 100, name: 'hundred' },
    ])
    .execute()
  await syncAutoIncrement(db, 'imported')
  expect(await insertReturningId(db, 'imported', { name: 'auto' })).toBe(101)
  await db.deleteFrom('imported').where('id', '=', 101).execute()
  // 自增主键不能复用刚删除的 ID。
  expect(await insertReturningId(db, 'imported', { name: 'after delete' })).toBe(102)
})

test('syncAutoIncrement 支持空表和自定义 ID 列', async () => {
  await syncAutoIncrement(db, 'empty_import', 'key')
  expect(await insertReturningId(db, 'empty_import', { name: 'first' }, 'key')).toBe(1)
})

test('syncAutoIncrement 不回退已用过的序列值', async () => {
  expect(await insertReturningId(db, 'used_sequence', { n: 1 })).toBe(1)
  await db.deleteFrom('used_sequence').execute()
  await syncAutoIncrement(db, 'used_sequence')
  expect(await insertReturningId(db, 'used_sequence', { n: 2 })).toBe(2)
})

test('PG 同步序列持有排他表锁，插入解锁后取得更大的 ID', async () => {
  // 只有 PG 需要显式同步序列；通过结果钩子保持事务打开，以观察并发 INSERT 的表锁。
  if (dialectOf(db) !== 'postgres') return
  await db.insertInto('sequence').values({ id: 100, n: 1 }).execute()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const insertPid = Promise.withResolvers<number>()
  const hold: KyselyPlugin = {
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => {
      if (result.rows.some((row) => typeof row === 'object' && row !== null && 'setval' in row)) {
        entered.resolve()
        await release.promise
      }
      return result
    },
  }
  const sync = syncAutoIncrement(db.withPlugin(hold), 'sequence')
  await entered.promise
  let completed = false
  const insert = db.connection().execute(async (connection) => {
    const {
      rows: [row],
    } = await sql<{ id: number }>`select pg_backend_pid() as id`.execute(connection)
    if (!row) throw new Error('未取得测试连接 ID')
    insertPid.resolve(row.id)
    const id = await insertReturningId(connection, 'sequence', { n: 2 })
    completed = true
    return id
  })
  try {
    const pid = await insertPid.promise
    await vi.waitFor(
      async () => {
        const result = await sql<{ waiting: boolean }>`select exists(select 1 from pg_locks
        where pid = ${pid} and relation = 'sequence'::regclass and mode = 'RowExclusiveLock' and not granted) as waiting`.execute(
          db,
        )
        expect(completed).toBe(false)
        expect(result.rows[0]?.waiting).toBe(true)
      },
      { timeout: 500 },
    )
  } finally {
    release.resolve()
    await sync
    expect(await insert).toBeGreaterThan(100)
  }
})

test('PG 同步序列复用调用方事务并将表锁保持到外层事务结束', async () => {
  if (dialectOf(db) !== 'postgres') return
  await db.transaction().execute(async (trx) => {
    await syncAutoIncrement(trx, 'sequence')
    const result = await sql<{ locked: boolean }>`select exists(select 1 from pg_locks
      where pid=pg_backend_pid() and relation='sequence'::regclass and mode='ExclusiveLock' and granted) as locked`.execute(
      trx,
    )
    expect(result.rows[0]?.locked).toBe(true)
  })
})
