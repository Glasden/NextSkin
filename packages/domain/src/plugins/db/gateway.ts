import { serialize } from 'node:v8'
import {
  compilePluginQuery,
  createPluginQueryExecutor,
  createPluginSqliteReader,
  dialectOf,
  dropPluginTables,
  listTablesWithPrefix,
  pluginQueryError,
  PluginQueryExecutionError,
  PluginReadError,
  type CoreDatabase,
} from '@nextskin/db'
import { rootLogger, type Logger } from '@nextskin/logging'
import { SelectQueryNode, type Kysely, type QueryResult } from 'kysely'
import { physicalName, physicalPrefix, PLUGIN_ID, PluginQueryRejected, sanitizePluginQuery } from './sanitize.ts'

export interface PluginQueryScope {
  pluginId: string
  /** 插件声明的逻辑表名 */
  tables: ReadonlySet<string>
  /** 只有迁移调用里为 true；DDL 只能在这里执行 */
  allowDdl: boolean
  /** 事务内的拦截器：语句随核心事务提交或回滚 */
  transaction?: Kysely<CoreDatabase>
  /** 这条语句最多执行多久（毫秒） */
  timeoutMs: number
}
export interface PluginQueryResult {
  rows: Record<string, unknown>[]
  numAffectedRows?: bigint
  insertId?: bigint
}
export class PluginDbError extends Error {
  readonly code: 'rejected' | 'timeout' | 'constraint' | 'failed'
  constructor(code: PluginDbError['code'], reason?: string) {
    super(code === 'rejected' ? (reason ?? 'Plugin query rejected') : `Plugin query ${code}`)
    this.name = 'PluginDbError'
    this.code = code
  }
}

export function createPluginDbGateway(options: {
  db: Kysely<CoreDatabase>
  /** SQLite 时传数据库文件，用来开插件专用的只读 worker 连接 */
  sqliteFile?: string
  logger?: Logger
}) {
  const { db } = options
  const log = (options.logger ?? rootLogger()).child({ area: 'plugin-db' })
  const executor = createPluginQueryExecutor(db)
  const reader = options.sqliteFile ? createPluginSqliteReader(options.sqliteFile) : undefined
  let closed = false
  return {
    async execute(scope: PluginQueryScope, node: unknown): Promise<PluginQueryResult> {
      const start = Date.now()
      try {
        if (closed) throw new PluginDbError('failed')
        if (!Number.isSafeInteger(scope.timeoutMs) || scope.timeoutMs <= 0 || scope.timeoutMs > 2147483647)
          throw new PluginQueryRejected('invalid statement timeout')
        const sanitized = sanitizePluginQuery(node, scope)
        // 传输层还须在解码前限制消息；这里同时覆盖官方插件在进程内的调用。
        if (serialize(sanitized).byteLength > 1024 * 1024) throw new PluginQueryRejected('query message exceeds 1 MiB')
        const deadline = start + scope.timeoutMs
        const compiled = compilePluginQuery(db, sanitized, deadline)
        let result: QueryResult<unknown>
        if (dialectOf(db) === 'sqlite' && SelectQueryNode.is(sanitized) && !scope.transaction) {
          if (!reader) throw new PluginDbError('failed')
          result = await reader.execute({
            pluginId: scope.pluginId,
            sql: compiled.sql,
            parameters: compiled.parameters,
            deadline,
          })
        } else {
          result = await executor.execute(scope.transaction ?? db, compiled, scope.timeoutMs)
        }
        if (result.rows.length > 10_000) throw new PluginQueryRejected('result exceeds 10000 rows')
        if (serialize(result).byteLength > 8 * 1024 * 1024)
          throw new PluginQueryRejected('result message exceeds 8 MiB')
        const cloned: PluginQueryResult = structuredClone({
          ...(result.numAffectedRows === undefined ? {} : { numAffectedRows: result.numAffectedRows }),
          ...(result.insertId === undefined ? {} : { insertId: result.insertId }),
          rows: result.rows.map((row) => ({ ...(row as Record<string, unknown>) })),
        })
        return cloned
      } catch (error) {
        if (error instanceof PluginDbError) throw error
        if (error instanceof PluginQueryRejected) throw new PluginDbError('rejected', error.message)
        if (error instanceof PluginReadError) throw new PluginDbError(error.code, error.message)
        const safe = error instanceof PluginQueryExecutionError ? error : pluginQueryError(error)
        throw new PluginDbError(safe.code)
      } finally {
        // 不记录 SQL、参数或底层异常。非法 id 不进入日志。
        if (PLUGIN_ID.test(scope.pluginId)) log.debug('query', { plugin: scope.pluginId, ms: Date.now() - start })
      }
    },
    async dropTables(pluginId: string, tables: readonly string[]): Promise<void> {
      try {
        if (closed) throw new PluginDbError('failed')
        if (!PLUGIN_ID.test(pluginId)) throw new PluginQueryRejected('invalid plugin id')
        await dropPluginTables(
          db,
          [...new Set(tables)].map((table) => physicalName(pluginId, table)),
        )
      } catch (error) {
        if (error instanceof PluginDbError) throw error
        if (error instanceof PluginQueryRejected) throw new PluginDbError('rejected', error.message)
        throw new PluginDbError(pluginQueryError(error).code)
      }
    },
    /** 卸载之后：这个插件的全部表，按物理名的前缀找，不依赖 manifest（处理卸载的实例可能没有它的包） */
    async dropAllTables(pluginId: string): Promise<void> {
      try {
        if (closed) throw new PluginDbError('failed')
        await dropPluginTables(db, await listTablesWithPrefix(db, physicalPrefix(pluginId)))
      } catch (error) {
        if (error instanceof PluginDbError) throw error
        if (error instanceof PluginQueryRejected) throw new PluginDbError('rejected', error.message)
        throw new PluginDbError(pluginQueryError(error).code)
      }
    },
    async close(): Promise<void> {
      closed = true
      await reader?.close()
      await executor.close()
    },
  }
}
