/**
 * 核心侧：插件数据库请求网关。
 *
 * - 每次核心调用插件（迁移、拦截器、路由……）都签发一个 invocation，插件在这次调用里发出的
 *   数据库请求都带着它；DDL 权限和"加入核心事务"都只由核心登记的 invocation 决定，不信任插件声明。
 * - 插件自己开启的事务有并发上限和超时，超时自动回滚，防止占住连接或 SQLite 的写锁。
 */
import { randomUUID } from 'node:crypto'
import { type ControlledTransaction, createQueryId, type Kysely, type QueryResult, type Transaction } from 'kysely'
import type { DbRequest } from './remote-dialect.ts'
import { PluginQueryRejected, physicalName, sanitizePluginQuery } from './sanitize'

export interface PluginInfo {
  id: string
  tables: ReadonlySet<string>
}

interface Invocation {
  allowDdl: boolean
  /** 拦截器在核心事务内运行时，指向核心事务 */
  coreTxId?: string
}

const MAX_ROWS = 10_000

export class PluginDbGateway {
  private invocations = new Map<string, Invocation>()
  private coreTransactions = new Map<string, Transaction<any>>()
  private pluginTransactions = new Map<string, { trx: ControlledTransaction<any>; timer: NodeJS.Timeout; deadline: number }>()
  /** 已占用的事务名额，包括正在开启、尚未登记的事务（先同步占位再 await，避免并发请求同时通过检查） */
  private reservedTransactions = 0
  readonly stats = { executed: 0, rejected: 0, autoRolledBack: 0 }

  constructor(
    private readonly db: Kysely<any>,
    private readonly plugin: PluginInfo,
    private readonly limits = { maxConcurrentTransactions: 2, transactionTimeoutMs: 2000 },
  ) {
    // 插件 id 和表名决定物理名，构造时就校验，保证不同插件的物理名不会冲突
    for (const table of plugin.tables) physicalName(plugin.id, table)
  }

  /** 核心发起一次插件调用前登记 invocation，调用结束后注销。 */
  async invoke<T>(options: { allowDdl?: boolean; coreTransaction?: Transaction<any> }, fn: (invocationId: string) => Promise<T>) {
    const invocationId = randomUUID()
    let coreTxId: string | undefined
    if (options.coreTransaction) {
      coreTxId = randomUUID()
      this.coreTransactions.set(coreTxId, options.coreTransaction)
    }
    this.invocations.set(invocationId, { allowDdl: options.allowDdl ?? false, coreTxId })
    try {
      return await fn(invocationId)
    } finally {
      this.invocations.delete(invocationId)
      if (coreTxId) this.coreTransactions.delete(coreTxId)
    }
  }

  async handle(request: DbRequest, invocationId: string | undefined): Promise<unknown> {
    const invocation = invocationId ? this.invocations.get(invocationId) : undefined
    switch (request.kind) {
      case 'query':
        return this.query(request.node, request.txId, invocation)
      case 'begin':
        return this.begin(invocation)
      case 'commit':
      case 'rollback':
        return this.finish(request.txId, request.kind)
    }
  }

  private async query(node: unknown, txId: string | undefined, invocation: Invocation | undefined) {
    let sanitized
    try {
      sanitized = sanitizePluginQuery(node, {
        pluginId: this.plugin.id,
        tables: this.plugin.tables,
        allowDdl: invocation?.allowDdl ?? false,
      })
    } catch (error) {
      this.stats.rejected++
      throw error
    }
    const target = txId
      ? this.pluginTransactions.get(txId)?.trx
      : invocation?.coreTxId
        ? this.coreTransactions.get(invocation.coreTxId)
        : this.db
    if (!target) throw new PluginQueryRejected('unknown or expired transaction')
    // 用核心自己的方言编译器重新编译；插件那边编译出的 SQL 从不使用
    const compiled = this.db.getExecutor().compileQuery(sanitized, createQueryId())
    const result: QueryResult<unknown> = await target.executeQuery(compiled)
    if (result.rows.length > MAX_ROWS) throw new PluginQueryRejected(`result exceeds ${MAX_ROWS} rows`)
    this.stats.executed++
    return result
  }

  private async begin(invocation: Invocation | undefined) {
    // 已经在核心事务里的调用不允许再开事务：插件的写入本来就随核心事务提交或回滚
    if (invocation?.coreTxId) throw new PluginQueryRejected('already inside a core transaction')
    if (this.reservedTransactions >= this.limits.maxConcurrentTransactions)
      throw new PluginQueryRejected('too many concurrent plugin transactions')
    this.reservedTransactions++
    let trx: ControlledTransaction<any>
    try {
      trx = await this.db.startTransaction().execute()
    } catch (error) {
      this.reservedTransactions--
      throw error
    }
    const txId = randomUUID()
    const deadline = Date.now() + this.limits.transactionTimeoutMs
    const timer = setTimeout(async () => {
      if (!this.pluginTransactions.delete(txId)) return
      this.reservedTransactions--
      this.stats.autoRolledBack++
      await trx.rollback().execute().catch(() => {})
    }, this.limits.transactionTimeoutMs)
    this.pluginTransactions.set(txId, { trx, timer, deadline })
    return txId
  }

  private async finish(txId: string, action: 'commit' | 'rollback') {
    const entry = this.pluginTransactions.get(txId)
    if (!entry) throw new PluginQueryRejected('unknown or expired transaction')
    this.pluginTransactions.delete(txId)
    this.reservedTransactions--
    clearTimeout(entry.timer)
    // SQLite 驱动是同步的：一条慢查询会让超时定时器来不及触发。提交时再检查一次期限。
    if (action === 'commit' && Date.now() > entry.deadline) {
      this.stats.autoRolledBack++
      await entry.trx.rollback().execute()
      throw new PluginQueryRejected('transaction exceeded its time limit and was rolled back')
    }
    await (action === 'commit' ? entry.trx.commit() : entry.trx.rollback()).execute()
    return null
  }
}
