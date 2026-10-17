import { setTimeout } from 'node:timers/promises'
import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { dialectOf } from './index.ts'
import { createTestDatabase, testDialect, type TestDatabase } from './testing.ts'
let database: TestDatabase<Record<string, never>>
let db: Kysely<Record<string, never>>
beforeAll(async () => {
  database = await createTestDatabase()
  db = database.db
})
afterAll(async () => {
  await database?.cleanup()
})

test('服务器会话使用 UTC，MySQL 应用约定的模式和字符集', async () => {
  // 各数据库检查会话设置的语法不同，只有此处按方言分支。
  if (dialectOf(db) === 'mysql') {
    const {
      rows: [session],
    } = await sql<{ zone: string; mode: string; charset: string }>`
      select @@session.time_zone as zone, @@session.sql_mode as mode, @@session.character_set_connection as charset`.execute(
      db,
    )
    expect(session?.zone).toBe('+00:00')
    expect(session?.charset).toBe('utf8mb4')
    // MariaDB 10.11 保留 tx_isolation，MySQL 8.4 使用 transaction_isolation。
    const isolation =
      testDialect() === 'mariadb'
        ? await sql<{ isolation: string }>`select @@session.tx_isolation as isolation`.execute(db)
        : await sql<{ isolation: string }>`select @@session.transaction_isolation as isolation`.execute(db)
    expect(isolation.rows[0]?.isolation).toBe('READ-COMMITTED')
    expect(session?.mode.split(',')).toEqual(
      expect.arrayContaining([
        'STRICT_TRANS_TABLES',
        'ONLY_FULL_GROUP_BY',
        'NO_ZERO_DATE',
        'NO_ZERO_IN_DATE',
        'ERROR_FOR_DIVISION_BY_ZERO',
        'NO_ENGINE_SUBSTITUTION',
      ]),
    )
    expect(session?.mode.split(',')).not.toContain('ANSI_QUOTES')
  } else if (dialectOf(db) === 'postgres') {
    expect((await sql<{ TimeZone: string }>`show TimeZone`.execute(db)).rows).toEqual([{ TimeZone: 'UTC' }])
  }
})

test('自己创建的空闲连接被终止后，连接池不会产生未捕获异常且能继续查询', async () => {
  // SQLite 无服务器会话；只终止本测试通过连接池获取的那个会话。
  if (dialectOf(db) === 'sqlite') return
  const admin = await createTestDatabase()
  let unhandled = 0
  const capture = () => {
    unhandled++
  }
  process.on('uncaughtException', capture)
  try {
    if (dialectOf(db) === 'postgres') {
      const {
        rows: [row],
      } = await sql<{ id: number }>`select pg_backend_pid() as id`.execute(db)
      if (!row) throw new Error('未取得本测试的会话 ID')
      await sql`select pg_terminate_backend(${row.id})`.execute(admin.db)
    } else {
      const {
        rows: [row],
      } = await sql<{ id: number }>`select connection_id() as id`.execute(db)
      if (!row) throw new Error('未取得本测试的会话 ID')
      await sql`kill connection ${sql.lit(row.id)}`.execute(admin.db)
    }
    await setTimeout(100)
    expect(unhandled).toBe(0)
    expect((await sql<{ n: number }>`select 1 as n`.execute(db)).rows).toEqual([{ n: 1 }])
  } finally {
    process.off('uncaughtException', capture)
    await admin.cleanup()
  }
})

test('MySQL 拒绝 LOCAL INFILE，不泄露文件参数且连接仍可使用', async () => {
  // SQLite/PG 没有此客户端能力；仅在 MySQL/MariaDB 上验证实际协议拒绝。
  if (dialectOf(db) !== 'mysql') return
  const { inspect } = await import('node:util')
  const secret = '/nonexistent/secret-local-infile-input.csv'
  await sql`create table local_load(n integer)`.execute(db)
  const failure: unknown = await sql`load data local infile ${secret} into table local_load`
    .execute(db)
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(inspect(failure, { depth: 10 })).not.toContain(secret)
  expect((await sql<{ n: number }>`select count(*) as n from local_load`.execute(db)).rows).toEqual([{ n: 0 }])
  expect((await sql<{ n: number }>`select 1 as n`.execute(db)).rows).toEqual([{ n: 1 }])
})
