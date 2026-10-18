import { DatabaseSync } from 'node:sqlite'
import { CompiledQuery, Kysely, MysqlDialect, PostgresDialect, SqliteDialect, sql, type Dialect } from 'kysely'
import { createPool } from 'mysql2'
import { Pool, types } from 'pg'
import { protectConnectionErrors } from './connection-errors.ts'
import { parseServerUrl } from './database.ts'
import { wrapNodeSqlite } from './sqlite/node-sqlite.ts'

/** 只读的外部数据库，例如导入器读的 BS 旧库。SQLite 的 file 是已存在的文件 */
export type SnapshotSource = { dialect: 'sqlite'; file: string } | { dialect: 'mysql' | 'postgres'; url: string }

// PostgreSQL 的 date、timestamp、timestamptz：原样返回字符串，不按进程时区换算成 Date
const PG_DATE_TYPES = new Set([1082, 1114, 1184])

/**
 * 在一个只读的一致快照里执行 read：MySQL / MariaDB 用 `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`
 * （会话改为 REPEATABLE READ，否则快照不生效），PostgreSQL 用 `REPEATABLE READ READ ONLY`，SQLite 以只读模式打开文件、
 * 在一个读事务里读。全程只有一条连接，read 里的查询都在同一个快照里。
 *
 * 整数可能读成 number、bigint 或字符串（超过 2^53 时），调用方自己转换。
 * 日期时间列一律读成数据库里存的字符串，不经过驱动的时区换算：MySQL 不设会话时区，`timestamp` 列按服务器默认时区
 * 读出，和写入它的应用（例如 Laravel）看到的一样。调用方按自己知道的时区解释
 */
export async function readSnapshot<DB, T>(source: SnapshotSource, read: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const db = new Kysely<DB>({ dialect: snapshotDialect(source) })
  let done = false
  let result: T
  try {
    result = await db.connection().execute(async (connection) => {
      if (source.dialect === 'mysql')
        await sql`start transaction with consistent snapshot, read only`.execute(connection)
      else if (source.dialect === 'postgres')
        await sql`begin isolation level repeatable read read only`.execute(connection)
      else await sql`begin`.execute(connection)
      try {
        // PostgreSQL 在第一条语句时取快照，SQLite 在第一次读库文件时；先读一次，快照从这里开始
        if (source.dialect === 'sqlite') await sql`select count(*) from sqlite_master`.execute(connection)
        else await sql`select 1`.execute(connection)
        const value = await read(connection)
        done = true
        return value
      } finally {
        // 只读事务没有要撤销的东西，回滚失败不改变结果；read 出错时保留它自己的错误
        await sql`rollback`.execute(connection).catch(() => {})
      }
    })
  } catch (error) {
    // read 已经完成时，收尾的失败（例如连接断开）不改变结果：调用方可能已经根据读到的数据提交了别处的事务，
    // 这里报错会让它误以为失败了
    if (!done) throw error
  } finally {
    await db.destroy().catch(() => {})
  }
  return result!
}

function snapshotDialect(source: SnapshotSource): Dialect {
  if (source.dialect === 'sqlite') {
    let database: DatabaseSync
    try {
      // 整数一律读成 bigint：旧库里可能有超过 2^53 的 id（例如 bigint 的 OAuth 客户端 id），默认会直接报错
      database = new DatabaseSync(source.file, { readOnly: true, readBigInts: true })
    } catch {
      // 不附原始错误：消息里有本地路径，调用方自己知道传了哪个文件
      throw new Error('打开 SQLite 数据库文件失败；请确认文件存在、进程有读权限')
    }
    // 旧站还在运行时，它的写事务会短暂占着锁；等一会儿再报 SQLITE_BUSY
    database.exec('pragma busy_timeout = 5000')
    return new SqliteDialect({ database: wrapNodeSqlite(database) })
  }
  const { secrets, mysql } = parseServerUrl(source)
  if (source.dialect === 'mysql') {
    let pool: ReturnType<typeof createPool>
    try {
      // 超过 2^53 的 bigint 读成字符串，不丢精度
      pool = createPool({ ...mysql!, connectionLimit: 1, dateStrings: true, supportBigNumbers: true })
    } catch {
      throw new Error('MySQL 连接配置无效；请检查 URL 中的参数及字符转义')
    }
    return protectConnectionErrors(
      new MysqlDialect({
        pool,
        onCreateConnection: async (connection) => {
          await connection.executeQuery(CompiledQuery.raw('set session transaction isolation level repeatable read'))
        },
      }),
      secrets,
    )
  }
  const pool = new Pool({
    connectionString: source.url,
    max: 1,
    types: {
      getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
        PG_DATE_TYPES.has(oid)
          ? (value: string) => value
          : (types.getTypeParser(oid, format) as (value: string) => unknown)) as never,
    },
  })
  pool.on('error', () => {})
  return protectConnectionErrors(new PostgresDialect({ pool }), secrets)
}
