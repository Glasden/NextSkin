import {
  AlterTableNode,
  CompiledQuery,
  CreateTableNode,
  LimitNode,
  OnNode,
  OperationNodeTransformer,
  SelectQueryNode,
  ValueNode,
  WhereNode,
  createQueryId,
  sql,
  type Kysely,
  type QueryResult,
  type RootOperationNode,
  type JoinNode,
  type UpdateQueryNode,
  type DeleteQueryNode,
} from 'kysely'
import { dialectOf } from '../helpers.ts'
import { PLUGIN_DEADLINE_ERROR } from './deadline.ts'

/** 方言处理集中在 db 包；网关只传入已重建的树。 */
class DeadlineTransformer extends OperationNodeTransformer {
  readonly deadline: number
  constructor(deadline: number) {
    super()
    this.deadline = deadline
  }
  private where(where?: WhereNode): WhereNode {
    const check = sql`nextskin_deadline(${this.deadline})`.toOperationNode()
    return where ? WhereNode.cloneWithOperation(where, 'And', check) : WhereNode.create(check)
  }
  protected override transformSelectQuery(node: SelectQueryNode): SelectQueryNode {
    const result = super.transformSelectQuery(node)
    return { ...result, where: this.where(result.where) }
  }
  protected override transformUpdateQuery(node: UpdateQueryNode): UpdateQueryNode {
    const result = super.transformUpdateQuery(node)
    return { ...result, where: this.where(result.where) }
  }
  protected override transformDeleteQuery(node: DeleteQueryNode): DeleteQueryNode {
    const result = super.transformDeleteQuery(node)
    return { ...result, where: this.where(result.where) }
  }
  protected override transformJoin(node: JoinNode): JoinNode {
    const result = super.transformJoin(node)
    const check = sql`nextskin_deadline(${this.deadline})`.toOperationNode()
    return { ...result, on: result.on ? OnNode.cloneWithOperation(result.on, 'And', check) : OnNode.create(check) }
  }
}

export class PluginQueryExecutionError extends Error {
  readonly code: 'timeout' | 'constraint' | 'failed'
  constructor(code: 'timeout' | 'constraint' | 'failed') {
    super(`Plugin query ${code}`)
    this.code = code
  }
}

export function pluginQueryError(error: unknown): PluginQueryExecutionError {
  if (error instanceof PluginQueryExecutionError) return error
  const fields = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  if (
    fields.code === '57014' ||
    fields.errno === 3024 ||
    fields.errno === 1969 ||
    fields.errno === 1317 ||
    (error instanceof Error && error.message === PLUGIN_DEADLINE_ERROR)
  )
    return new PluginQueryExecutionError('timeout')
  if (
    (typeof fields.code === 'string' && fields.code.startsWith('23')) ||
    (typeof fields.errcode === 'number' && (fields.errcode & 255) === 19) ||
    [1048, 1062, 1364, 1451, 1452, 3819, 4025].includes(Number(fields.errno)) ||
    (error instanceof Error && /^(NOT NULL|FOREIGN KEY|CHECK|UNIQUE) constraint failed/.test(error.message))
  )
    return new PluginQueryExecutionError('constraint')
  return new PluginQueryExecutionError('failed')
}

/** 只修改可信的重建结果；内部新增的 RawNode 从不来自插件。 */
export function compilePluginQuery<DB>(db: Kysely<DB>, input: RootOperationNode, deadline: number): CompiledQuery {
  const dialect = dialectOf(db)
  let node = input
  if (SelectQueryNode.is(node)) {
    const limit = node.limit?.limit
    if (!limit || !ValueNode.is(limit) || Number(limit.value) > 10_000) {
      node = { ...node, limit: LimitNode.create(ValueNode.create(10_001)) }
    }
  }
  if (dialect === 'sqlite') node = new DeadlineTransformer(deadline).transformNode(node)
  if (dialect === 'mysql' && CreateTableNode.is(node)) {
    // MySQL 忽略列级 REFERENCES，统一提升为表级外键；字符集和核心建表保持一致。
    const constraints = [...(node.constraints ?? [])]
    const columns = node.columns.map((column) => {
      if (!column.references) return column
      constraints.push({
        kind: 'ForeignKeyConstraintNode',
        columns: [column.column],
        references: { ...column.references, onDelete: undefined, onUpdate: undefined },
        onDelete: column.references.onDelete,
        onUpdate: column.references.onUpdate,
      })
      return { ...column, references: undefined }
    })
    node = {
      ...node,
      columns,
      constraints,
      endModifiers: [sql`default character set utf8mb4 collate utf8mb4_bin`.toOperationNode()],
    }
  }
  if (dialect === 'mysql' && AlterTableNode.is(node)) {
    const additions: ReturnType<typeof sql>[] = []
    const columnAlterations = node.columnAlterations?.map((alteration) => {
      if (alteration.kind !== 'AddColumnNode' || !alteration.column.references) return alteration
      const { column } = alteration
      const reference = column.references!
      const actions = {
        cascade: sql`cascade`,
        'set null': sql`set null`,
        restrict: sql`restrict`,
        'no action': sql`no action`,
        'set default': sql`set default`,
      }
      additions.push(
        sql`, add foreign key (${sql.id(column.column.column.name)}) references ${sql.id(reference.table.table.identifier.name)} (${sql.join(reference.columns.map((c) => sql.id(c.column.name)))})${reference.onDelete ? sql` on delete ${actions[reference.onDelete]}` : sql``}${reference.onUpdate ? sql` on update ${actions[reference.onUpdate]}` : sql``}`,
      )
      return { ...alteration, column: { ...column, references: undefined } }
    })
    const alter = { ...node, columnAlterations }
    if (additions.length) node = sql`${{ toOperationNode: () => alter }}${sql.join(additions, sql``)}`.toOperationNode()
  }
  return db.getExecutor().compileQuery(node, createQueryId())
}

export function createPluginQueryExecutor<DB>(db: Kysely<DB>) {
  const dialect = dialectOf(db)
  let maria: Promise<boolean> | undefined
  let closed = false
  const transactions = new WeakMap<Kysely<DB>, Promise<QueryResult<unknown>>>()

  function connectionBefore<T>(
    target: Kysely<DB>,
    deadline: number,
    run: (connection: Kysely<DB>) => Promise<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let expired = false
      const timer = setTimeout(
        () => {
          expired = true
          reject(new PluginQueryExecutionError('timeout'))
        },
        Math.max(1, deadline - Date.now()),
      )
      void target
        .connection()
        .execute(async (connection) => {
          // 池满时不能无限等；迟到的租约只释放，绝不执行已超时的语句。
          if (expired || Date.now() >= deadline) throw new PluginQueryExecutionError('timeout')
          if (closed) throw new PluginQueryExecutionError('failed')
          clearTimeout(timer)
          return run(connection)
        })
        .then(resolve, reject)
        .finally(() => clearTimeout(timer))
    })
  }

  async function execute(target: Kysely<DB>, query: CompiledQuery, timeoutMs: number): Promise<QueryResult<unknown>> {
    if (closed) throw new PluginQueryExecutionError('failed')
    try {
      if (dialect === 'sqlite') {
        // 循环中的期限检查来自重建后的树。纯 VALUES INSERT、DDL 没有 WHERE 检查点；
        // node:sqlite 没有 interrupt/progress handler，无法对这些同步操作承诺硬时限。
        return await target.executeQuery(query)
      }
      if (dialect === 'postgres') {
        const run = async (trx: Kysely<DB>) => {
          await trx.executeQuery(CompiledQuery.raw(`set local statement_timeout = ${timeoutMs}`))
          const result = await trx.executeQuery(query)
          await trx.executeQuery(CompiledQuery.raw('set local statement_timeout = default'))
          return result
        }
        return target.isTransaction ? await run(target) : await target.transaction().execute(run)
      }
      maria ??= sql<{ version: string }>`select version() as version`
        .execute(target)
        .then((result) => /mariadb/i.test(result.rows[0]!.version))
      if (await maria) {
        return await target.executeQuery({
          ...query,
          sql: `SET STATEMENT max_statement_time=${timeoutMs / 1000} FOR ${query.sql}`,
        })
      }
      if (SelectQueryNode.is(query.query)) {
        return await target.executeQuery({
          ...query,
          sql: query.sql.replace(/^select\b/i, `select /*+ MAX_EXECUTION_TIME(${timeoutMs}) */`),
        })
      }
      const deadline = Date.now() + timeoutMs
      // 每条写语句先租控制连接；结束即归还。只有一个连接的池会按预算拒绝，不会永久占住池。
      return await connectionBefore(db, deadline, async (control) => {
        const run = async (connection: Kysely<DB>) => {
          const result = await sql<{ id: number }>`select connection_id() as id`.execute(connection)
          const id = Number(result.rows[0]!.id)
          if (!Number.isSafeInteger(id) || id <= 0) throw new PluginQueryExecutionError('failed')
          const remaining = deadline - Date.now()
          if (remaining <= 0) throw new PluginQueryExecutionError('timeout')
          let timedOut = false
          let kill: Promise<unknown> | undefined
          const timer = setTimeout(() => {
            timedOut = true
            kill = control.executeQuery(CompiledQuery.raw(`KILL QUERY ${id}`)).catch(() => {})
          }, remaining)
          try {
            const rows = await connection.executeQuery(query)
            if (timedOut) throw new PluginQueryExecutionError('timeout')
            return rows
          } catch (error) {
            if (timedOut) throw new PluginQueryExecutionError('timeout')
            throw error
          } finally {
            clearTimeout(timer)
            // 等 KILL 结束才释放执行连接，防止迟到的 KILL 误杀后续核心查询。
            await kill
          }
        }
        return target.isTransaction ? await run(target) : await connectionBefore(target, deadline, run)
      })
    } catch (error) {
      throw pluginQueryError(error)
    }
  }
  function scopedExecute(target: Kysely<DB>, query: CompiledQuery, timeoutMs: number): Promise<QueryResult<unknown>> {
    if (!target.isTransaction) return execute(target, query, timeoutMs)
    // SET LOCAL 和对应语句必须连续执行，防止同一事务的并发插件查询覆盖彼此的超时。
    const previous = transactions.get(target) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => execute(target, query, timeoutMs))
    transactions.set(target, pending)
    const clear = () => {
      if (transactions.get(target) === pending) transactions.delete(target)
    }
    void pending.then(clear, clear)
    return pending
  }
  return {
    execute: scopedExecute,
    close(): Promise<void> {
      closed = true
      return Promise.resolve()
    },
  }
}

/** 调用方已校验物理名。SQLite 延迟检查外键；PG 同时删除；MySQL 在专用连接暂时关闭检查。 */
export async function dropPluginTables<DB>(db: Kysely<DB>, names: readonly string[]): Promise<void> {
  if (!names.length) return
  const dialect = dialectOf(db)
  if (dialect === 'sqlite') {
    await db.transaction().execute(async (trx) => {
      await sql`pragma defer_foreign_keys = on`.execute(trx)
      for (const name of names) await sql`drop table if exists ${sql.id(name)}`.execute(trx)
    })
  } else if (dialect === 'postgres') {
    await sql`drop table if exists ${sql.join(names.map((name) => sql.id(name)))}`.execute(db)
  } else {
    await db.connection().execute(async (connection) => {
      const previous = await sql<{ enabled: number }>`select @@foreign_key_checks as enabled`.execute(connection)
      await sql`set foreign_key_checks = 0`.execute(connection)
      try {
        await sql`drop table if exists ${sql.join(names.map((name) => sql.id(name)))}`.execute(connection)
      } finally {
        await sql`set foreign_key_checks = ${Number(previous.rows[0]!.enabled)}`.execute(connection)
      }
    })
  }
}
