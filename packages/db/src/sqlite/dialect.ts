import { DatabaseSync, constants } from 'node:sqlite'
import {
  SelectQueryNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  type SqliteDatabase,
} from 'kysely'
import { registerPluginDeadline } from './deadline.ts'
import { wrapNodeSqlite } from './node-sqlite.ts'

/** 不依赖 DatabaseSync，以便后续通过 worker RPC 执行查询和检查事务状态。 */
export interface Backend {
  execute(sql: string, parameters: readonly unknown[]): Promise<QueryResult<unknown>>
  executeControl(sql: string): Promise<void>
  isInTransaction(): Promise<boolean>
  close(): Promise<void>
}

const READ_ACTIONS = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_FUNCTION,
  constants.SQLITE_RECURSIVE,
])
const READ_PRAGMAS_WITH_ARGUMENTS = new Set([
  'table_info',
  'table_xinfo',
  'index_info',
  'index_xinfo',
  'index_list',
  'foreign_key_list',
  'foreign_key_check',
  'integrity_check',
  'quick_check',
])
const RAW_CONTROL_ERROR = '禁止通过原始 SQL 控制事务；请使用 db.transaction()、startTransaction() 或 savepoint()'

class MainBackend implements Backend {
  #allowControl = false
  #deniedControl = false
  #deniedWrite = false
  readonly #db: DatabaseSync
  readonly database: SqliteDatabase

  constructor(file: string, readOnly: boolean, busyTimeoutMs: number) {
    const db = new DatabaseSync(file, { readOnly })
    this.#db = db
    try {
      db.exec(`pragma busy_timeout = ${busyTimeoutMs}`)
      if (!readOnly) db.exec('pragma journal_mode = wal')
      db.exec('pragma synchronous = normal; pragma foreign_keys = on')
      registerPluginDeadline(db)
      db.setAuthorizer((action, name, argument) => {
        if (action === constants.SQLITE_TRANSACTION || action === constants.SQLITE_SAVEPOINT) {
          if (this.#allowControl && !readOnly) return constants.SQLITE_OK
          this.#deniedControl = true
          return constants.SQLITE_DENY
        }
        if (readOnly && !READ_ACTIONS.has(action)) {
          if (
            action === constants.SQLITE_PRAGMA &&
            (argument === null || READ_PRAGMAS_WITH_ARGUMENTS.has(name?.toLowerCase() ?? ''))
          ) {
            return constants.SQLITE_OK
          }
          this.#deniedWrite = true
          return constants.SQLITE_DENY
        }
        return constants.SQLITE_OK
      })
      this.database = wrapNodeSqlite(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  execute(sql: string, parameters: readonly unknown[]): Promise<QueryResult<unknown>> {
    this.#deniedControl = false
    this.#deniedWrite = false
    try {
      const statement = this.database.prepare(sql)
      if (statement.reader) return Promise.resolve({ rows: statement.all(parameters) })
      const result = statement.run(parameters)
      return Promise.resolve({
        rows: [],
        numAffectedRows: BigInt(result.changes),
        insertId: BigInt(result.lastInsertRowid),
      })
    } catch (error) {
      if (this.#deniedControl) return Promise.reject(new Error(RAW_CONTROL_ERROR))
      if (this.#deniedWrite) return Promise.reject(new Error('SQLite 只读连接拒绝写入；请通过写连接执行写操作'))
      return Promise.reject(
        error instanceof Error ? error : new Error('SQLite 查询失败；请检查参数、表结构及数据库状态'),
      )
    }
  }

  executeControl(sql: string): Promise<void> {
    // authorizer 只在编译时检查。控制语句不能进入与用户共享的预编译缓存。
    this.#allowControl = true
    try {
      this.#db.exec(sql)
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('SQLite 事务控制失败'))
    } finally {
      this.#allowControl = false
    }
  }

  isInTransaction(): Promise<boolean> {
    return Promise.resolve(this.#db.isTransaction)
  }

  close(): Promise<void> {
    this.database.close()
    return Promise.resolve()
  }
}

export class SqliteWriteLockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `等待 SQLite 写锁超过 ${timeoutMs} 毫秒；事务回调里请用 trx，不要用外层的 db。若仍超时，请检查是否有长事务占用写锁`,
    )
    this.name = 'SqliteWriteLockTimeoutError'
  }
}

class WriteLock {
  #held = false
  #queue: { grant: () => void; cancel: () => void }[] = []
  closed = false
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs
  }

  assertOpen(): void {
    if (this.closed) throw new Error('SQLite 数据库已关闭；请创建新的数据库实例')
  }

  close(): void {
    this.closed = true
    for (const waiter of this.#queue.splice(0)) waiter.cancel()
  }

  acquire(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('SQLite 数据库已关闭；请创建新的数据库实例'))
    if (!this.#held) {
      this.#held = true
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(timer)
          resolve()
        },
        cancel: () => {
          clearTimeout(timer)
          reject(new Error('SQLite 数据库已关闭；写锁等待已取消，请创建新的数据库实例'))
        },
      }
      const timer = setTimeout(() => {
        const index = this.#queue.indexOf(waiter)
        if (index >= 0) this.#queue.splice(index, 1)
        reject(new SqliteWriteLockTimeoutError(this.timeoutMs))
      }, this.timeoutMs)
      this.#queue.push(waiter)
    })
  }

  release(): void {
    const next = this.#queue.shift()
    if (next) next.grant()
    else this.#held = false
  }
}

export interface SqliteOptions {
  file: string
  busyTimeoutMs?: number
  lockTimeoutMs?: number
}

class RoutedConnection implements DatabaseConnection {
  inTransaction = false
  transactionTerminated = false
  readonly driver: SqliteDriver
  constructor(driver: SqliteDriver) {
    this.driver = driver
  }

  async assertTransactionActive(): Promise<void> {
    this.driver.lock.assertOpen()
    if (!this.inTransaction) throw new Error('当前连接不在事务中；请先调用 startTransaction()')
    if (this.transactionTerminated || !(await this.driver.writer.isInTransaction())) {
      this.transactionTerminated = true
      throw new Error('事务已被 SQLite 回滚；请重试整个事务，不要继续使用此事务连接')
    }
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.driver.lock.assertOpen()
    if (this.inTransaction) {
      await this.assertTransactionActive()
      return (await this.driver.writer.execute(query.sql, query.parameters)) as QueryResult<R>
    }
    if (SelectQueryNode.is(query.query))
      return (await this.driver.reader.execute(query.sql, query.parameters)) as QueryResult<R>
    await this.driver.lock.acquire()
    try {
      this.driver.lock.assertOpen()
      return (await this.driver.writer.execute(query.sql, query.parameters)) as QueryResult<R>
    } finally {
      this.driver.lock.release()
    }
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('SQLite 不支持流式查询；请改用 execute()')
  }
}

class SqliteDriver implements Driver {
  readonly options: SqliteOptions
  readonly lock: WriteLock
  writer!: Backend
  reader!: Backend

  constructor(options: SqliteOptions) {
    this.options = options
    this.lock = new WriteLock(options.lockTimeoutMs ?? 5000)
  }

  async init(): Promise<void> {
    const { file, busyTimeoutMs = 100 } = this.options
    this.writer = new MainBackend(file, false, busyTimeoutMs)
    try {
      this.reader = new MainBackend(file, true, busyTimeoutMs)
    } catch (error) {
      await this.writer.close()
      throw error
    }
  }

  acquireConnection(): Promise<DatabaseConnection> {
    if (this.lock.closed) return Promise.reject(new Error('SQLite 数据库已关闭；请创建新的数据库实例'))
    return Promise.resolve(new RoutedConnection(this))
  }

  async beginTransaction(connection: RoutedConnection): Promise<void> {
    // SQLite 本身就是串行化隔离，忽略 isolationLevel 和 accessMode。
    await this.lock.acquire()
    try {
      this.lock.assertOpen()
      await this.writer.executeControl('begin immediate')
      connection.transactionTerminated = false
      connection.inTransaction = true
    } catch (error) {
      this.lock.release()
      throw error
    }
  }

  async commitTransaction(connection: RoutedConnection): Promise<void> {
    // Kysely 0.29 的普通事务在提交失败后自动回滚，受控事务则由调用方回滚或重试；此前必须保留写锁。
    await connection.assertTransactionActive()
    await this.writer.executeControl('commit')
    connection.inTransaction = false
    this.lock.release()
  }

  async rollbackTransaction(connection: RoutedConnection): Promise<void> {
    if (!connection.inTransaction) return
    try {
      // SQLite 可能已自动回滚；再次回滚会覆盖调用方原本的错误。
      if (!this.lock.closed && (await this.writer.isInTransaction())) await this.writer.executeControl('rollback')
    } finally {
      connection.inTransaction = false
      this.lock.release()
    }
  }

  async savepoint(connection: RoutedConnection, name: string): Promise<void> {
    await connection.assertTransactionActive()
    await this.writer.executeControl(`savepoint ${quoteIdentifier(name)}`)
  }
  async rollbackToSavepoint(connection: RoutedConnection, name: string): Promise<void> {
    await connection.assertTransactionActive()
    await this.writer.executeControl(`rollback to savepoint ${quoteIdentifier(name)}`)
  }
  async releaseSavepoint(connection: RoutedConnection, name: string): Promise<void> {
    await connection.assertTransactionActive()
    await this.writer.executeControl(`release savepoint ${quoteIdentifier(name)}`)
  }
  async releaseConnection(connection: RoutedConnection): Promise<void> {
    if (connection.inTransaction) await this.rollbackTransaction(connection)
  }
  async destroy(): Promise<void> {
    this.lock.close()
    try {
      await this.reader.close()
    } finally {
      await this.writer.close()
    }
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

class MultiConnectionAdapter extends SqliteAdapter {
  // Migrator 必须在 BEGIN IMMEDIATE 内读迁移状态并执行 DDL，才能保证多连接互斥和迁移原子性。
  override get supportsTransactionalDdl(): boolean {
    return true
  }

  override get supportsMultipleConnections(): boolean {
    return true
  }
}

export class SqliteWalDialect implements Dialect {
  readonly options: SqliteOptions
  constructor(options: SqliteOptions) {
    if (options.file === ':memory:' || options.file === '')
      throw new Error('SQLite 的 WAL 读写连接需要共享文件；请将 file 设为非空数据库文件路径，不要使用 :memory:')
    for (const value of [options.busyTimeoutMs ?? 100, options.lockTimeoutMs ?? 5000]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)
        throw new RangeError(
          'SQLite 超时配置无效；请将 busyTimeoutMs 和 lockTimeoutMs 设为 0 到 2147483647 之间的整数毫秒数',
        )
    }
    this.options = { ...options }
  }
  createDriver(): Driver {
    return new SqliteDriver(this.options)
  }
  createQueryCompiler(): SqliteQueryCompiler {
    return new SqliteQueryCompiler()
  }
  createAdapter(): SqliteAdapter {
    return new MultiConnectionAdapter()
  }
  createIntrospector(db: Kysely<unknown>): SqliteIntrospector {
    return new SqliteIntrospector(db)
  }
}
