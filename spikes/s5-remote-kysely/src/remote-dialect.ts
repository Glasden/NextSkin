/**
 * 插件侧：一个"不连数据库"的 Kysely 方言。
 *
 * 查询照常用 Kysely 构建和编译（使用核心实际方言的适配器和编译器，保证 returning 等能力判断一致），
 * 但驱动只把编译结果里的操作节点树（compiledQuery.query）发给核心；插件这边编译出的 SQL 字符串被丢弃。
 *
 * 本文件在插件 host 进程里由 Node 原生类型剥离直接运行，只能使用可擦除的 TS 语法。
 */
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  MysqlAdapter,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresQueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteQueryCompiler,
} from 'kysely'

export type CoreDialect = 'sqlite' | 'postgres' | 'mysql'

export type DbRequest =
  | { kind: 'query'; node: unknown; txId?: string }
  | { kind: 'begin' }
  | { kind: 'commit'; txId: string }
  | { kind: 'rollback'; txId: string }

export type DbRpc = (request: DbRequest) => Promise<any>

class RemoteConnection implements DatabaseConnection {
  txId: string | undefined
  readonly rpc: DbRpc

  constructor(rpc: DbRpc) {
    this.rpc = rpc
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    return this.rpc({ kind: 'query', node: compiledQuery.query, txId: this.txId })
  }

  // biome-ignore lint/correctness/useYield: 不支持流式查询
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streaming is not supported for plugin queries')
  }
}

class RemoteDriver implements Driver {
  readonly rpc: DbRpc

  constructor(rpc: DbRpc) {
    this.rpc = rpc
  }

  async init() {}
  async acquireConnection() {
    return new RemoteConnection(this.rpc)
  }
  async beginTransaction(connection: DatabaseConnection) {
    ;(connection as RemoteConnection).txId = await this.rpc({ kind: 'begin' })
  }
  async commitTransaction(connection: DatabaseConnection) {
    const remote = connection as RemoteConnection
    await this.rpc({ kind: 'commit', txId: remote.txId! })
    remote.txId = undefined
  }
  async rollbackTransaction(connection: DatabaseConnection) {
    const remote = connection as RemoteConnection
    await this.rpc({ kind: 'rollback', txId: remote.txId! })
    remote.txId = undefined
  }
  async releaseConnection() {}
  async destroy() {}
}

export function remoteDialect(core: CoreDialect, rpc: DbRpc): Dialect {
  const pick = {
    sqlite: { adapter: SqliteAdapter, compiler: SqliteQueryCompiler },
    postgres: { adapter: PostgresAdapter, compiler: PostgresQueryCompiler },
    mysql: { adapter: MysqlAdapter, compiler: MysqlQueryCompiler },
  }[core]
  return {
    createAdapter: () => new pick.adapter(),
    createDriver: () => new RemoteDriver(rpc),
    createQueryCompiler: () => new pick.compiler(),
    createIntrospector: (_db: Kysely<any>) => {
      throw new Error('introspection is not available to plugins')
    },
  }
}
