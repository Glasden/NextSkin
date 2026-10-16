/**
 * 测试插件：声明两张表 codes、logs。
 * 前半部分是正常使用；后半部分是攻击尝试，每一项都应当被核心拒绝。
 * 只能使用可擦除的 TS 语法（由 Node 原生类型剥离运行）。
 */
import { readFileSync } from 'node:fs'
import { type Kysely, sql } from 'kysely'
import type { DbRequest } from './remote-dialect.ts'

export interface DB {
  codes: { code: string; status: string; used_by: number | null; n: number }
  logs: { code: string; at: string }
}

export type Op = (db: Kysely<DB>, args: any, rpc: (request: DbRequest) => Promise<any>) => Promise<unknown>
// 攻击用例需要绕过类型系统，模拟手写 JS 或被篡改的插件
const any = (db: Kysely<DB>) => db as unknown as Kysely<any>

const tableNode = (name: string) => ({
  kind: 'TableNode',
  table: { kind: 'SchemableIdentifierNode', identifier: { kind: 'IdentifierNode', name } },
})

export const ops = {
  // ---------------------------------------------------------------- 迁移
  async migrate(db) {
    await db.schema
      .createTable('codes')
      .addColumn('code', 'varchar(32)', (col) => col.primaryKey())
      .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('unused'))
      .addColumn('used_by', 'integer')
      .addColumn('n', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
    await db.schema
      .createTable('logs')
      .addColumn('code', 'varchar(32)', (col) => col.notNull().references('codes.code').onDelete('cascade'))
      .addColumn('at', 'varchar(32)', (col) => col.notNull())
      .execute()
    await db.schema.createIndex('logs_code').on('logs').column('code').execute()
    return 'ok'
  },

  // ---------------------------------------------------------------- 正常使用
  async insertCodes(db) {
    await db
      .insertInto('codes')
      .values([
        { code: 'A1', status: 'unused', used_by: null, n: 1 },
        { code: 'A2', status: 'used', used_by: 7, n: 2 },
        { code: 'B1', status: 'unused', used_by: null, n: 3 },
      ])
      .execute()
    await db.insertInto('logs').values([{ code: 'A2', at: '2026-10-16T00:00:00Z' }]).execute()
    return (await db.selectFrom('codes').select('code').orderBy('code').execute()).map((r) => r.code)
  },
  async selectFiltered(db) {
    return db
      .selectFrom('codes')
      .select(['code', 'n'])
      .where('code', 'like', 'A%')
      .where('status', 'in', ['unused', 'used'])
      .orderBy('n', 'desc')
      .limit(10)
      .offset(0)
      .execute()
  },
  async aggregate(db) {
    const rows = await db
      .selectFrom('codes')
      .select((eb) => ['status', eb.fn.countAll().as('count'), eb.fn.sum('n').as('total')])
      .groupBy('status')
      .orderBy('status')
      .execute()
    return rows.map((r) => ({ status: r.status, count: Number(r.count), total: Number(r.total) }))
  },
  async joinWithAliases(db) {
    return db
      .selectFrom('codes as c')
      .innerJoin('logs as l', 'l.code', 'c.code')
      .select(['c.code', 'l.at'])
      .execute()
  },
  async subqueries(db) {
    const inLogs = await db
      .selectFrom('codes')
      .select('code')
      .where('code', 'in', (eb) => eb.selectFrom('logs').select('logs.code'))
      .execute()
    const withoutLogs = await db
      .selectFrom('codes as c')
      .select('c.code')
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('logs').select('logs.code').whereRef('logs.code', '=', 'c.code'))))
      .orderBy('c.code')
      .execute()
    return { inLogs: inLogs.map((r) => r.code), withoutLogs: withoutLogs.map((r) => r.code) }
  },
  async updateAndDelete(db) {
    const updated = await db.updateTable('codes').set({ status: 'used', used_by: 9 }).where('code', '=', 'B1').executeTakeFirst()
    const deleted = await db.deleteFrom('codes').where('code', '=', 'A1').executeTakeFirst()
    return { updated: Number(updated.numUpdatedRows), deleted: Number(deleted.numDeletedRows) }
  },
  async upsert(db, args: { dialect: string }) {
    const row = { code: 'A2', status: 'used', used_by: 7, n: 100 }
    const query = db.insertInto('codes').values(row)
    if (args.dialect === 'mysql') await query.onDuplicateKeyUpdate({ n: (eb) => eb.fn('values', [eb.ref('n')]) }).execute()
    else await query.onConflict((oc) => oc.column('code').doUpdateSet({ n: (eb) => eb.ref('excluded.n') })).execute()
    return (await db.selectFrom('codes').select('n').where('code', '=', 'A2').executeTakeFirstOrThrow()).n
  },
  async pluginTransaction(db) {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('codes').values({ code: 'T1', status: 'unused', used_by: null, n: 0 }).execute()
    })
    await db
      .transaction()
      .execute(async (trx) => {
        await trx.insertInto('codes').values({ code: 'T2', status: 'unused', used_by: null, n: 0 }).execute()
        throw new Error('rollback on purpose')
      })
      .catch(() => {})
    const codes = await db.selectFrom('codes').select('code').where('code', 'in', ['T1', 'T2']).execute()
    return codes.map((r) => r.code)
  },
  /** 由核心在自己的事务里调用：写入应随核心事务提交或回滚。 */
  async hookWrite(db, args: { code: string }) {
    await db.insertInto('codes').values({ code: args.code, status: 'unused', used_by: null, n: 0 }).execute()
    return 'written'
  },
  async count(db, args: { code: string }) {
    const row = await db.selectFrom('codes').select((eb) => eb.fn.countAll().as('c')).where('code', '=', args.code).executeTakeFirstOrThrow()
    return Number(row.c)
  },
  async bench(db, args: { n: number }) {
    const start = performance.now()
    for (let i = 0; i < args.n; i++) await db.selectFrom('codes').select('code').where('code', '=', 'A2').execute()
    return (performance.now() - start) / args.n
  },

  // ---------------------------------------------------------------- 攻击：通过查询构建器
  attackCoreTable: (db) => any(db).selectFrom('users').selectAll().execute(),
  attackRawSql: (db) => sql`select * from users`.execute(db),
  attackRawFragment: (db) => db.selectFrom('codes').selectAll().where(sql<boolean>`1 = 1 or exists (select 1 from users)`).execute(),
  attackSchemaQualified: (db) => any(db).selectFrom('information_schema.tables').selectAll().execute(),
  attackSqliteMaster: (db) => any(db).selectFrom('main.sqlite_master').selectAll().execute(),
  attackJoinCore: (db) => any(db).selectFrom('codes').innerJoin('users', 'users.id', 'codes.used_by').selectAll().execute(),
  attackSubqueryCore: (db) =>
    any(db).selectFrom('codes').select('code').where('code', 'in', (eb: any) => eb.selectFrom('users').select('email')).execute(),
  attackAliasAsSource: (db) =>
    any(db)
      .selectFrom('codes as users')
      .select('users.code')
      .where((eb: any) => eb.exists(eb.selectFrom('users').select('users.email')))
      .execute(),
  attackFunction: (db) => db.selectFrom('codes').select((eb) => eb.fn<string>('load_extension', [eb.val('x')]).as('x')).execute(),
  attackSleep: (db) => db.selectFrom('codes').select((eb) => eb.fn<number>('pg_sleep', [eb.val(10)]).as('x')).execute(),
  attackLiteral: (db) => db.selectFrom('codes').select((eb) => eb.lit(1).as('one')).execute(),
  attackDdlOutsideMigration: (db) =>
    any(db).schema.createTable('codes2').addColumn('x', 'integer').execute(),
  attackUndeclaredTable: (db) => any(db).insertInto('evil').values({ x: 1 }).execute(),

  // ---------------------------------------------------------------- 攻击：在迁移调用里（DDL 被允许的上下文）
  attackDropCoreTable: (db) => any(db).schema.dropTable('users').execute(),
  attackForeignKeyToCore: (db) =>
    any(db).schema.alterTable('logs').addColumn('uid', 'integer', (col: any) => col.references('users.id')).execute(),
  attackIndexOnCore: (db) => any(db).schema.createIndex('steal').on('users').column('email').execute(),

  // ---------------------------------------------------------------- 攻击：手工伪造的节点树
  attackForgedOperator: (_db, _args, rpc) =>
    rpc({
      kind: 'query',
      node: {
        kind: 'SelectQueryNode',
        from: { kind: 'FromNode', froms: [tableNode('codes')] },
        selections: [{ kind: 'SelectionNode', selection: { kind: 'SelectAllNode' } }],
        where: {
          kind: 'WhereNode',
          where: {
            kind: 'BinaryOperationNode',
            leftOperand: { kind: 'ColumnNode', column: { kind: 'IdentifierNode', name: 'code' } },
            operator: { kind: 'OperatorNode', operator: '= code union select email, null, null, null from users --' },
            rightOperand: { kind: 'ValueNode', value: 'x' },
          },
        },
      },
    }),
  attackForgedDataType: (_db, _args, rpc) =>
    rpc({
      kind: 'query',
      node: {
        kind: 'CreateTableNode',
        table: tableNode('codes'),
        columns: [
          {
            kind: 'ColumnDefinitionNode',
            column: { kind: 'ColumnNode', column: { kind: 'IdentifierNode', name: 'x' } },
            dataType: { kind: 'DataTypeNode', dataType: 'integer); drop table users; --' },
          },
        ],
      },
    }),
  attackForgedIdentifier: (_db, _args, rpc) =>
    rpc({
      kind: 'query',
      node: {
        kind: 'SelectQueryNode',
        from: { kind: 'FromNode', froms: [tableNode('codes')] },
        selections: [
          { kind: 'SelectionNode', selection: { kind: 'ColumnNode', column: { kind: 'IdentifierNode', name: 'code" from users --' } } },
        ],
      },
    }),
  attackForgedExtraField: (_db, _args, rpc) =>
    rpc({
      kind: 'query',
      node: {
        kind: 'SelectQueryNode',
        from: { kind: 'FromNode', froms: [tableNode('codes')] },
        selections: [{ kind: 'SelectionNode', selection: { kind: 'SelectAllNode' } }],
        with: { kind: 'WithNode', expressions: [] },
      },
    }),
  attackForgedRawDirection: (_db, _args, rpc) =>
    rpc({
      kind: 'query',
      node: {
        kind: 'SelectQueryNode',
        from: { kind: 'FromNode', froms: [tableNode('codes')] },
        selections: [{ kind: 'SelectionNode', selection: { kind: 'SelectAllNode' } }],
        orderBy: {
          kind: 'OrderByNode',
          items: [
            {
              kind: 'OrderByItemNode',
              orderBy: { kind: 'ColumnNode', column: { kind: 'IdentifierNode', name: 'code' } },
              direction: { kind: 'RawNode', sqlFragments: ['desc; drop table users'], parameters: [] },
            },
          ],
        },
      },
    }),
  attackHugeList: (db) =>
    db.selectFrom('codes').selectAll().where('code', 'in', Array.from({ length: 50_000 }, (_, i) => `c${i}`)).execute(),
  attackCyclicTree: (_db, _args, rpc) => {
    const node: any = { kind: 'ParensNode' }
    node.node = node
    return rpc({
      kind: 'query',
      node: {
        kind: 'SelectQueryNode',
        from: { kind: 'FromNode', froms: [tableNode('codes')] },
        selections: [{ kind: 'SelectionNode', selection: { kind: 'SelectAllNode' } }],
        where: { kind: 'WhereNode', where: node },
      },
    })
  },
  /** 开启事务后不提交：核心应在超时后自动回滚并释放连接。 */
  async attackHangingTransaction(_db, _args, rpc) {
    const txId = await rpc({ kind: 'begin' })
    await rpc({
      kind: 'query',
      txId,
      node: {
        kind: 'InsertQueryNode',
        into: tableNode('codes'),
        columns: ['code', 'status', 'n'].map((name) => ({ kind: 'ColumnNode', column: { kind: 'IdentifierNode', name } })),
        values: { kind: 'ValuesNode', values: [{ kind: 'PrimitiveValueListNode', values: ['HANG', 'unused', 0] }] },
      },
    })
    return txId
  },

  // ---------------------------------------------------------------- 回归：独立审核发现的问题
  /** 一元负号嵌套：修复前会编译成 `--"n"`（SQL 行注释）。 */
  async doubleNegation(db) {
    const row = await db
      .selectFrom('codes')
      .select((eb) => eb.neg(eb.neg(eb.ref('n'))).as('m'))
      .where('code', '=', 'A2')
      .executeTakeFirstOrThrow()
    return Number(row.m)
  },
  /** 6 KB 的二进制参数：修复前会被当成 6000 个节点而误判为"查询过大"。 */
  async binaryParam(db) {
    const rows = await any(db).selectFrom('codes').select('code').where('code', '=', new Uint8Array(6000).fill(0x41)).execute()
    return rows.length
  },
  attackCommaJoin: (db) => any(db).selectFrom(['codes', 'logs']).selectAll().execute(),
  attackDateParam: (db) =>
    any(db).insertInto('codes').values({ code: 'D1', status: 'unused', used_by: null, n: new Date() }).execute(),
  attackHugeString: (db) => db.selectFrom('codes').selectAll().where('code', '=', 'x'.repeat(1024 * 1024)).execute(),
  attackInsertSelect: (db) =>
    any(db)
      .insertInto('codes')
      .columns(['code', 'status', 'n'])
      .expression((eb: any) => eb.selectFrom('codes as a').innerJoin('codes as b', 'a.n', 'b.n').select(['a.code', 'a.status', 'a.n']))
      .execute(),
  attackUpdateReturning: (_db, _args, rpc) =>
    rpc({
      kind: 'query',
      node: {
        kind: 'UpdateQueryNode',
        table: tableNode('codes'),
        updates: [
          { kind: 'ColumnUpdateNode', column: { kind: 'ColumnNode', column: { kind: 'IdentifierNode', name: 'n' } }, value: { kind: 'ValueNode', value: 1 } },
        ],
        returning: { kind: 'ReturningNode', selections: [{ kind: 'SelectionNode', selection: { kind: 'SelectAllNode' } }] },
      },
    }),

  // ---------------------------------------------------------------- 进程级安全带
  readSecretFile: async (_db, args: { path: string }) => readFileSync(args.path, 'utf8'),
  readEnv: async () => process.env.DATABASE_URL ?? null,
} satisfies Record<string, Op>
