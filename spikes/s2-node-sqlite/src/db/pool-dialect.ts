/**
 * 多连接的 SQLite 方言：一个写连接 + 若干读连接，连接可以放在主线程，也可以放在 worker 线程。
 *
 * 路由规则：
 * - 事务内的一切查询走写连接（事务期间独占写锁）；
 * - 事务外的 SELECT 走读连接（WAL 模式下读不等写，也不被写事务挡住）；
 * - 事务外的写语句走写连接，排在写锁后面，不会插进别人的事务里。
 *
 * Kysely 的 RuntimeDriver 只在 adapter.supportsMultipleConnections === false 时加全局互斥锁，
 * 这里返回 true，互斥由本驱动的写锁负责。
 */
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import {
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  SelectQueryNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'
import { CORE_PRAGMAS, wrapNodeSqlite } from './node-sqlite.ts'
import type { WorkerInit, WorkerRequest, WorkerResponse } from './sqlite-worker.ts'

export interface Backend {
  readonly kind: 'main' | 'worker'
  inflight: number
  execute(sql: string, params: ReadonlyArray<unknown>): Promise<QueryResult<unknown>>
  close(): Promise<void>
}

class MainBackend implements Backend {
  readonly kind = 'main'
  inflight = 0
  #db: DatabaseSync
  #wrapped
  constructor(file: string, readOnly: boolean, busyTimeoutMs: number) {
    this.#db = new DatabaseSync(file, { readOnly, timeout: busyTimeoutMs })
    for (const p of CORE_PRAGMAS) if (!(readOnly && p.includes('journal_mode'))) this.#db.exec(p)
    this.#wrapped = wrapNodeSqlite(this.#db)
  }
  // 同步执行：函数体里没有 await，调用方拿到的 Promise 在执行完毕后才产生
  execute(sql: string, params: ReadonlyArray<unknown>): Promise<QueryResult<unknown>> {
    try {
      const st = this.#wrapped.prepare(sql)
      if (st.reader) return Promise.resolve({ rows: st.all(params) })
      const r = st.run(params)
      return Promise.resolve({ rows: [], numAffectedRows: BigInt(r.changes), insertId: BigInt(r.lastInsertRowid) })
    } catch (e) {
      return Promise.reject(e)
    }
  }
  async close() {
    this.#db.close()
  }
}

export class WorkerBackend implements Backend {
  readonly kind = 'worker'
  inflight = 0
  readonly worker: Worker
  #next = 1
  #pending = new Map<number, { resolve: (r: QueryResult<unknown>) => void; reject: (e: unknown) => void }>()
  constructor(init: WorkerInit) {
    this.worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { workerData: init })
    this.worker.on('message', (res: WorkerResponse) => {
      const p = this.#pending.get(res.id)
      if (!p) return
      this.#pending.delete(res.id)
      this.inflight--
      if (res.ok) {
        p.resolve(
          res.changes === undefined
            ? { rows: res.rows }
            : { rows: [], numAffectedRows: BigInt(res.changes), insertId: BigInt(res.lastInsertRowid!) },
        )
      } else {
        p.reject(Object.assign(new Error(res.message), { code: res.code, errcode: res.errcode }))
      }
    })
    this.worker.on('error', (e) => this.#failAll(e))
    this.worker.on('exit', (code) => this.#failAll(new Error(`SQLite worker 退出，code=${code}`)))
  }
  #failAll(e: unknown) {
    for (const p of this.#pending.values()) p.reject(e)
    this.#pending.clear()
    this.inflight = 0
  }
  execute(sql: string, params: ReadonlyArray<unknown>): Promise<QueryResult<unknown>> {
    const id = this.#next++
    this.inflight++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, sql, params } satisfies WorkerRequest)
    })
  }
  async close() {
    await this.worker.terminate()
  }
}

class Lock {
  #held = false
  #queue: (() => void)[] = []
  acquire(): Promise<void> {
    if (!this.#held) {
      this.#held = true
      return Promise.resolve()
    }
    return new Promise((r) => this.#queue.push(r))
  }
  release() {
    const next = this.#queue.shift()
    if (next) next()
    else this.#held = false
  }
}

/** 写连接和写锁。核心与插件的 Kysely 实例共用同一份，保证全进程只有一个写者。 */
export class WriterState {
  readonly lock = new Lock()
  readonly backend: Backend
  constructor(backend: Backend) {
    this.backend = backend
  }
}

export interface PoolOptions {
  writer: WriterState
  /** 事务外的 SELECT 用的读连接；为空时一切都走写连接 */
  readers: Backend[]
  /** 本实例是否负责关闭写连接 */
  ownsWriter: boolean
}

class RoutedConnection implements DatabaseConnection {
  /** 已开启事务、持有写锁 */
  inTx = false
  private driver: PoolDriver
  constructor(driver: PoolDriver) {
    this.driver = driver
  }
  async executeQuery<R>(cq: CompiledQuery): Promise<QueryResult<R>> {
    const d = this.driver
    if (this.inTx) return (await d.writer.backend.execute(cq.sql, cq.parameters)) as QueryResult<R>
    if (d.readers.length > 0 && SelectQueryNode.is(cq.query)) {
      return (await d.pickReader().execute(cq.sql, cq.parameters)) as QueryResult<R>
    }
    await d.writer.lock.acquire()
    try {
      return (await d.writer.backend.execute(cq.sql, cq.parameters)) as QueryResult<R>
    } finally {
      d.writer.lock.release()
    }
  }
  // biome-ignore lint/correctness/useYield: 不支持流式
  async *streamQuery(): AsyncIterableIterator<QueryResult<never>> {
    throw new Error('不支持流式查询')
  }
}

class PoolDriver implements Driver {
  #rr = 0
  readonly opts: PoolOptions
  constructor(opts: PoolOptions) {
    this.opts = opts
  }
  get writer() {
    return this.opts.writer
  }
  get readers() {
    return this.opts.readers
  }
  pickReader(): Backend {
    // 选在途请求最少的；相同时轮转，避免总压在第一个上
    const rs = this.opts.readers
    let best = rs[this.#rr++ % rs.length]!
    for (const r of rs) if (r.inflight < best.inflight) best = r
    return best
  }
  async init() {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return new RoutedConnection(this)
  }
  async beginTransaction(conn: DatabaseConnection) {
    const c = conn as RoutedConnection
    await this.writer.lock.acquire()
    try {
      await this.writer.backend.execute('begin immediate', [])
      c.inTx = true
    } catch (e) {
      this.writer.lock.release()
      throw e
    }
  }
  async commitTransaction(conn: DatabaseConnection) {
    const c = conn as RoutedConnection
    // commit 失败时保持持锁状态，Kysely 随后会调用 rollbackTransaction
    await this.writer.backend.execute('commit', [])
    c.inTx = false
    this.writer.lock.release()
  }
  async rollbackTransaction(conn: DatabaseConnection) {
    const c = conn as RoutedConnection
    if (!c.inTx) return
    try {
      await this.writer.backend.execute('rollback', [])
    } finally {
      c.inTx = false
      this.writer.lock.release()
    }
  }
  async savepoint(conn: DatabaseConnection, name: string) {
    await (conn as RoutedConnection).executeQuery(CompiledQuery.raw(`savepoint "${name}"`))
  }
  async rollbackToSavepoint(conn: DatabaseConnection, name: string) {
    await (conn as RoutedConnection).executeQuery(CompiledQuery.raw(`rollback to "${name}"`))
  }
  async releaseSavepoint(conn: DatabaseConnection, name: string) {
    await (conn as RoutedConnection).executeQuery(CompiledQuery.raw(`release "${name}"`))
  }
  async releaseConnection(conn: DatabaseConnection) {
    // 正常流程里事务结束时已经释放；这里兜底，防止异常路径漏放写锁
    if ((conn as RoutedConnection).inTx) await this.rollbackTransaction(conn)
  }
  async destroy() {
    await Promise.all(this.opts.readers.map((r) => r.close()))
    if (this.opts.ownsWriter) await this.opts.writer.backend.close()
  }
}

class MultiConnAdapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    return true
  }
}

export class PoolDialect implements Dialect {
  private opts: PoolOptions
  constructor(opts: PoolOptions) {
    this.opts = opts
  }
  createDriver() {
    return new PoolDriver(this.opts)
  }
  createQueryCompiler() {
    return new SqliteQueryCompiler()
  }
  createAdapter() {
    return new MultiConnAdapter()
  }
  createIntrospector(db: Kysely<any>) {
    return new SqliteIntrospector(db)
  }
}

export function mainBackend(file: string, readOnly: boolean, busyTimeoutMs = 5000): Backend {
  return new MainBackend(file, readOnly, busyTimeoutMs)
}
export function workerBackend(init: WorkerInit): Backend {
  return new WorkerBackend(init)
}
