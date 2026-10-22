// 画面里的 SQL 和节点树由仓库里的代码现算（ADR-0055）：
// - 邀请码插件 user.register 拦截器的查询（plugins/invitation-codes），经 packages/domain 的 sanitizePluginQuery 重建，
//   再用核心的方言编译器编译；两个越权的查询交给它，记下拒绝的原因
// - settings 的 upsert 在四种数据库上实际发出的语句，照 packages/db 的 upsert 的两条分支拼
/* eslint-disable nextskin/no-direct-score-write, nextskin/no-dialect-specific-sql -- 只编译、不执行：拼出插件查询和 upsert 实际发出的语句，显示在画面上。 */
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type OperationNode,
} from 'kysely'
import { PluginQueryRejected, sanitizePluginQuery } from '../../../packages/domain/src/plugins/db/sanitize.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = any

const dialects = {
  sqlite: () => ({
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db: Kysely<AnyDB>) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  }),
  mysql: () => ({
    createAdapter: () => new MysqlAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db: Kysely<AnyDB>) => new MysqlIntrospector(db),
    createQueryCompiler: () => new MysqlQueryCompiler(),
  }),
  postgres: () => ({
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db: Kysely<AnyDB>) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  }),
}
const make = (name: keyof typeof dialects) => new Kysely<AnyDB>({ dialect: dialects[name]() })

/** 节点树压成缩进的行：类型和一个能看懂的值 */
function outline(node: OperationNode, depth = 0, rows: { depth: number; kind: string; value: string }[] = []) {
  const n = node as unknown as Record<string, unknown> & { kind: string }
  let value = ''
  if (n.kind === 'TableNode') value = (n.table as { identifier: { name: string } }).identifier.name
  else if (n.kind === 'ColumnUpdateNode') value = (n.column as { column: { name: string } }).column.name
  else if (n.kind === 'BinaryOperationNode') {
    const left = n.leftOperand as { kind: string; column?: { column: { name: string } } }
    const op = (n.operator as { operator: string }).operator
    value = `${left.column?.column.name ?? '…'} ${op} ?`
  }
  rows.push({ depth, kind: n.kind, value })
  const children: OperationNode[] = []
  if (n.kind === 'UpdateQueryNode') {
    children.push(n.table as OperationNode, ...((n.updates as OperationNode[]) ?? []), n.where as OperationNode)
  } else if (n.kind === 'WhereNode') children.push(n.where as OperationNode)
  else if (n.kind === 'AndNode' || n.kind === 'OrNode') children.push(n.left as OperationNode, n.right as OperationNode)
  for (const child of children) if (child) outline(child, depth + 1, rows)
  return rows
}

export function generateQueries() {
  const plugin = make('sqlite')
  const pluginId = 'invitation-codes'
  const options = { pluginId, tables: new Set(['codes']), allowDdl: false }
  // plugins/invitation-codes 的 user.register 拦截器（略去过期时间的条件）
  const query = plugin
    .updateTable('codes')
    .set({ status: 'used' })
    .where('code', '=', 'K7Q2-M9XD')
    .where('status', '=', 'unused')
  // 插件进程发出来的是结构化克隆后的节点树，不是 SQL
  const sent = structuredClone(query.toOperationNode())
  const rebuilt = sanitizePluginQuery(sent, options)
  const compiled = new SqliteQueryCompiler().compileQuery(rebuilt, { queryId: 'site' })

  const rejection = (node: unknown) => {
    try {
      sanitizePluginQuery(structuredClone(node), options)
    } catch (error) {
      if (error instanceof PluginQueryRejected) return error.message
      throw error
    }
    throw new Error('越权的查询没有被拒绝')
  }
  const raw = rejection(sql`drop table users`.toOperationNode())
  const foreign = rejection(plugin.updateTable('users').set({ score: 999999 }).toOperationNode())

  // settings 的 upsert（packages/domain/src/admin/settings.ts 的那次调用）
  const values = { namespace: 'core', key: 'site.name', value: '"NextSkin"', updated_at: '2026-10-21T12:00:00.000Z' }
  const onConflict = (db: Kysely<AnyDB>) =>
    db
      .insertInto('settings')
      .values(values)
      .onConflict((oc) =>
        oc
          .columns(['namespace', 'key'])
          .doUpdateSet({ value: sql.ref('excluded.value'), updated_at: sql.ref('excluded.updated_at') }),
      )
      .compile().sql
  const mysql = make('mysql')
  const mysqlUpdate = mysql
    .updateTable('settings')
    .set({ value: values.value, updated_at: values.updated_at })
    .where(sql<boolean>`${sql.ref('namespace')} = ${values.namespace}`)
    .where(sql<boolean>`${sql.ref('key')} = ${values.key}`)
    .compile().sql
  const mysqlInsert = mysql.insertInto('settings').values(values).compile().sql

  return {
    plugin: {
      id: pluginId,
      tree: outline(sent),
      sql: compiled.sql,
      raw,
      foreign,
    },
    upsert: {
      sqlite: onConflict(make('sqlite')),
      postgres: onConflict(make('postgres')),
      mysqlUpdate,
      mysqlInsert,
    },
  }
}
