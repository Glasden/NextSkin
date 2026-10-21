import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sql, type Kysely, type RawBuilder } from 'kysely'
import { dialectOf } from './helpers.ts'
import { sqliteFileOf } from './sqlite/dialect.ts'

/** 锁被别人拿着：调用方按"正忙，稍后再试"处理 */
export class ExclusiveLockBusyError extends Error {
  override name = 'ExclusiveLockBusyError'
  constructor() {
    super('锁被占用')
  }
}

/** 本进程里各数据库实例上拿着的锁名：同名的不排队，立即报忙 */
const held = new WeakMap<object, Set<string>>()
/** 本进程里各数据库实例上排着队、等着占一条连接拿锁的操作 */
const gates = new WeakMap<object, Promise<void>>()

/**
 * MySQL / PostgreSQL 上拿锁和解锁的语句。解锁把这个会话拿着的锁全放掉：拿锁的连接同时只拿这一把，
 * 别的都是以前解锁失败留下的（这两种锁在同一个会话里可以重入，留在连接池里会被下一个拿到这条连接的人"拿到"）
 */
export function lockStatements(
  dialect: 'mysql' | 'postgres',
  name: string,
): { acquire: RawBuilder<{ acquired: unknown }>; releaseAll: RawBuilder<unknown> } {
  if (dialect === 'mysql') {
    // GET_LOCK 的锁名最长 64 个字符，SHA2 的十六进制正好 64 个；锁在整个 MySQL 服务上共享，按 DATABASE() 区分站点
    const key = sql`sha2(concat(database(), ':', ${name}), 256)`
    return { acquire: sql`select get_lock(${key}, 0) as acquired`, releaseAll: sql`select release_all_locks()` }
  }
  // advisory lock 本来就按库区分；64 位的键取自锁名的 sha256
  const key = BigInt.asIntN(64, BigInt(`0x${createHash('sha256').update(name).digest('hex').slice(0, 16)}`)).toString()
  return {
    acquire: sql`select pg_try_advisory_lock(${key}::bigint) as acquired`,
    releaseAll: sql`select pg_advisory_unlock_all()`,
  }
}

/** SQLite 的锁文件：数据库文件旁边的 `<库文件>-locks/<锁名的 sha256>.lock`，每个锁名一个，用完不删 */
export function sqliteLockFile(file: string, name: string): string {
  return join(`${file}-locks`, `${createHash('sha256').update(name).digest('hex')}.lock`)
}

// 排他事务依附连接；拿着锁期间留一个强引用，不让 GC 提前关掉它（同启动器的数据目录锁）
const lockFiles = new Set<DatabaseSync>()

/** 打开锁文件、开一个排他事务，拿不到立即报忙；关掉连接就是回滚、放锁。进程退出时操作系统也会释放 */
async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true })
  const lock = new DatabaseSync(file, { timeout: 0 })
  try {
    try {
      lock.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      // SQLITE_BUSY：别的进程（或本进程的另一个连接池）拿着
      if ((error as { errcode?: number }).errcode === 5) throw new ExclusiveLockBusyError()
      throw error
    }
    lockFiles.add(lock)
    return await fn()
  } finally {
    lockFiles.delete(lock)
    lock.close()
  }
}

/** 每个连接池在本进程里同时只让一把锁占着连接，别的排队 */
async function throughGate<T>(db: object, fn: () => Promise<T>): Promise<T> {
  const previous = gates.get(db) ?? Promise.resolve()
  let open!: () => void
  const current = new Promise<void>((resolve) => (open = resolve))
  const next = previous.then(() => current)
  gates.set(db, next)
  await previous
  try {
    return await fn()
  } finally {
    open()
    if (gates.get(db) === next) gates.delete(db)
  }
}

/**
 * 跨进程的互斥锁，同名的锁被别人拿着就立即抛 `ExclusiveLockBusyError`，不等。用来串行化多实例上会做外部副作用
 * （跑插件迁移、删存储里的文件）的操作：这些副作用回滚不了，事务里的行锁又不能跨过它们一直拿着。
 *
 * - MySQL / MariaDB 用 `GET_LOCK`，PostgreSQL 用会话级的 advisory lock，都拿在一条专用的连接上：
 *   进程中途退出、连接断开时数据库自动释放，不用估计租约多长。解锁失败时锁留在这条连接的会话上，
 *   直到它下次被用来拿锁（用完放掉会话上所有的锁）或者被连接池关掉。不在这里结束会话：连接池会把断开的连接
 *   交给下一个查询，PostgreSQL 的客户端还会抛出没人接的 error 事件；
 * - 拿锁的连接在本进程里同时只占一条，名字不同的排队：fn 里的查询和事务从连接池里取别的连接，
 *   几把锁同时各占一条连接会把池占满，fn 就再也取不到连接。所以连接池至少要有两条连接；
 * - SQLite 上命令行和服务是两个进程（ADR-0049），用数据库文件旁边的锁文件（sqliteLockFile）：开一个排他事务，
 *   和启动器锁数据目录的办法一样，进程不论怎么退出都由操作系统释放。名字不同的互不影响。
 *
 * 不可重入，fn 里也不能再拿任何一把锁（会排在自己后面）
 */
export async function withExclusiveLock<DB, T>(db: Kysely<DB>, name: string, fn: () => Promise<T>): Promise<T> {
  let names = held.get(db)
  if (!names) held.set(db, (names = new Set()))
  if (names.has(name)) throw new ExclusiveLockBusyError()
  names.add(name)
  try {
    const dialect = dialectOf(db)
    if (dialect === 'sqlite') {
      const file = sqliteFileOf(db)
      return file ? await withFileLock(sqliteLockFile(file, name), fn) : await fn()
    }
    return await throughGate(db, () =>
      db.connection().execute(async (connection) => {
        const statements = lockStatements(dialect, name)
        const { rows } = await statements.acquire.execute(connection)
        // GET_LOCK 返回 1 / 0 / NULL，pg_try_advisory_lock 返回布尔
        if (Number(rows[0]?.acquired) !== 1) throw new ExclusiveLockBusyError()
        try {
          return await fn()
        } finally {
          // 解锁失败不影响 fn 的结果：见上
          await statements.releaseAll.execute(connection).catch(() => {})
        }
      }),
    )
  } finally {
    names.delete(name)
  }
}
