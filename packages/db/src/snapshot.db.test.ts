import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { dialectOf } from './helpers.ts'
import { readSnapshot, type SnapshotSource } from './snapshot.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

interface SourceDatabase {
  items: { id: number; name: string; at: string; stamp: string | null }
}

let database: TestDatabase<SourceDatabase>
let db: Kysely<SourceDatabase>
let source: SnapshotSource

beforeAll(async () => {
  database = await createTestDatabase<SourceDatabase>()
  db = database.db
  const config = database.config
  source = config.dialect === 'sqlite' ? { dialect: 'sqlite', file: config.file } : config
  // 照 Laravel 在三种数据库上的列类型：dateTime、timestamp
  const dialect = dialectOf(db)
  const datetime = dialect === 'postgres' ? sql`timestamp(0) without time zone` : sql`datetime`
  const timestamp = dialect === 'postgres' ? sql`timestamp(0) without time zone` : sql`timestamp null`
  await sql`create table items (id integer primary key, name varchar(50) not null, at ${datetime} not null, stamp ${timestamp})`.execute(
    db,
  )
  await sql`insert into items (id, name, at, stamp) values (1, ${'Steve'}, ${'2026-01-02 08:04:05'}, ${'2026-01-03 09:00:00'})`.execute(
    db,
  )
})
afterAll(async () => database?.cleanup())

test('日期时间列读出数据库里存的字符串，不按进程时区换算', async () => {
  const rows = await readSnapshot<SourceDatabase, { id: unknown }[]>(source, (snapshot) =>
    snapshot.selectFrom('items').selectAll().execute(),
  )
  // 整数在 SQLite 上读成 bigint（防止超过 2^53 的值报错），比较前统一成 number
  expect(rows.map((row) => ({ ...row, id: Number(row.id) }))).toEqual([
    { id: 1, name: 'Steve', at: '2026-01-02 08:04:05', stamp: '2026-01-03 09:00:00' },
  ])
})

test('快照开始之后别的连接提交的写入，快照里看不到', async () => {
  const seen = await readSnapshot<SourceDatabase, number[][]>(source, async (snapshot) => {
    const before = await snapshot.selectFrom('items').select('id').orderBy('id').execute()
    await sql`insert into items (id, name, at) values (2, ${'Alex'}, ${'2026-01-02 08:04:05'})`.execute(db)
    const after = await snapshot.selectFrom('items').select('id').orderBy('id').execute()
    return [before.map((row) => Number(row.id)), after.map((row) => Number(row.id))]
  })
  expect(seen).toEqual([[1], [1]])
  expect((await db.selectFrom('items').select('id').orderBy('id').execute()).map((row) => row.id)).toEqual([1, 2])
  await db.deleteFrom('items').where('id', '=', 2).execute()
})

test('快照里不能写', async () => {
  await expect(
    readSnapshot<SourceDatabase, unknown>(source, (snapshot) =>
      snapshot.insertInto('items').values({ id: 3, name: 'x', at: '2026-01-01 00:00:00', stamp: null }).execute(),
    ),
  ).rejects.toThrow()
  expect(await db.selectFrom('items').select('id').where('id', '=', 3).execute()).toEqual([])
})

test('超过 2^53 的整数不丢精度，也不报错', async () => {
  const value = await readSnapshot<SourceDatabase, unknown>(source, async (snapshot) => {
    const row = await sql<{ big: unknown }>`select ${sql.raw('9007199254740993')} as big`.execute(snapshot)
    return row.rows[0]!.big
  })
  expect(String(value)).toBe('9007199254740993')
})

test('读完之后收尾出错，不改变结果', async () => {
  const value = await readSnapshot<SourceDatabase, string>(source, async (snapshot) => {
    // 提前结束事务：SQLite 上收尾的 rollback 会报"没有活动的事务"
    await sql`rollback`.execute(snapshot).catch(() => {})
    return 'read'
  })
  expect(value).toBe('read')
})
