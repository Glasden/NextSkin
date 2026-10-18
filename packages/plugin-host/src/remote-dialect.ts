/**
 * 插件侧：一个不连数据库的 Kysely 方言（S5）。
 *
 * 查询照常用 Kysely 构建和编译，用的是核心实际方言的适配器和编译器，`returning` 等能力判断与核心一致；
 * 驱动只把编译结果里的操作节点树（`compiledQuery.query`）交给核心，插件这边编译出的 SQL 字符串被丢弃。
 * 核心按白名单重建这棵树，换上物理表名，再用自己的编译器重新编译执行。
 *
 * 插件不能自己开事务（ADR-0033）：每条语句单独提交。事务内的拦截器发出的语句由核心放进核心事务，
 * 插件这边不需要知道。
 */
import {
  MysqlAdapter,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely'

export type CoreDialect = 'sqlite' | 'mysql' | 'postgres'

/** 把一棵操作节点树交给核心执行。 */
export type PluginDbRpc = (node: unknown) => Promise<QueryResult<unknown>>

export const NO_TRANSACTIONS = '插件不能自己开事务（ADR-0033）：每条语句单独提交，需要原子性就写一条带条件的语句'

class RemoteConnection implements DatabaseConnection {
  readonly rpc: PluginDbRpc
  constructor(rpc: PluginDbRpc) {
    this.rpc = rpc
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    return (await this.rpc(compiledQuery.query)) as QueryResult<R>
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('插件查询不支持流式读取')
  }
}

class RemoteDriver implements Driver {
  readonly rpc: PluginDbRpc
  constructor(rpc: PluginDbRpc) {
    this.rpc = rpc
  }

  async init(): Promise<void> {}
  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(new RemoteConnection(this.rpc))
  }
  beginTransaction(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS))
  }
  commitTransaction(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS))
  }
  rollbackTransaction(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS))
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export function remoteDialect(core: CoreDialect, rpc: PluginDbRpc): Dialect {
  const pick = {
    sqlite: { adapter: SqliteAdapter, compiler: SqliteQueryCompiler },
    postgres: { adapter: PostgresAdapter, compiler: PostgresQueryCompiler },
    mysql: { adapter: MysqlAdapter, compiler: MysqlQueryCompiler },
  }[core]
  return {
    createAdapter: () => new pick.adapter(),
    createDriver: () => new RemoteDriver(rpc),
    createQueryCompiler: () => new pick.compiler(),
    createIntrospector: () => {
      throw new Error('插件不能内省数据库')
    },
  }
}
