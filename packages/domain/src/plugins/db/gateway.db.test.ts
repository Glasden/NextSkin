/* eslint-disable nextskin/no-dialect-specific-sql -- 测试插件的远程 Kysely 需要覆盖实际发来的方言节点。 */
import {
  coreMigrations,
  migrateToLatest,
  dialectOf,
  compilePluginQuery,
  toIsoTimestamp,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { remoteDialect } from '@nextskin/plugin-host'
import { Kysely, sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createPluginDbGateway, type PluginQueryScope } from './gateway.ts'
import { physicalName, sanitizePluginQuery } from './sanitize.ts'

interface Tables {
  codes: { code: string; status: string; used_by: number | null; n: number }
  logs: { code: string; at: string }
  numbers: { n: number }
}
let database: TestDatabase<CoreDatabase>
let gateway: ReturnType<typeof createPluginDbGateway>
let plugin: Kysely<Tables>
let scope: PluginQueryScope
const row = (code: string, n = 1) => ({ code, n, status: 'unused', used_by: null })
const tables = new Set(['codes', 'logs', 'numbers'])
const logs: string[] = []
const sentinel = {
  namespace: 'core',
  key: 'plugin-test-sentinel',
  value: 'core-private-value',
  updated_at: toIsoTimestamp(new Date('2026-10-18T00:00:00.000Z')),
}
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
  await database.db.insertInto('settings').values(sentinel).execute()
  scope = { pluginId: 'invite-codes', tables, allowDdl: true, timeoutMs: 5000 }
  gateway = createPluginDbGateway({
    db: database.db,
    sqliteFile: database.config.dialect === 'sqlite' ? database.config.file : undefined,
    log: (line) => logs.push(line),
  })
  plugin = new Kysely<Tables>({
    dialect: remoteDialect(dialectOf(database.db), (node) => gateway.execute(scope, structuredClone(node))),
  })
  await plugin.schema
    .createTable('codes')
    .addColumn('code', 'varchar(32)', (c) => c.primaryKey())
    .addColumn('status', 'varchar(16)', (c) => c.notNull().defaultTo('unused'))
    .addColumn('used_by', 'integer')
    .addColumn('n', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()
  await plugin.schema
    .createTable('logs')
    .addColumn('code', 'varchar(32)', (c) => c.notNull().references('codes.code').onDelete('restrict'))
    .addColumn('at', 'varchar(32)', (c) => c.notNull())
    .execute()
  await plugin.schema
    .alterTable('logs')
    .addColumn('related', 'varchar(32)', (c) => c.references('codes.code'))
    .execute()
  await plugin.schema.createIndex('logs_code').on('logs').column('code').execute()
  await plugin.schema
    .createTable('numbers')
    .addColumn('n', 'integer', (c) => c.primaryKey())
    .execute()
  scope = { ...scope, allowDdl: false }
})
afterAll(async () => {
  await plugin?.destroy()
  await gateway?.close()
  await database?.cleanup()
})

test('迁移的物理表和索引都有前缀', async () => {
  expect((await database.db.introspection.getTables()).map((t) => t.name)).toContain('p_invite_codes__codes')
  const index = sanitizePluginQuery(
    plugin.schema.createIndex('logs_code').on('logs').column('code').toOperationNode(),
    { ...scope, allowDdl: true },
  )
  expect(compilePluginQuery(database.db, index, Date.now() + 1000).sql).toContain('p_invite_codes__logs_code')
})

test('插入、排序、聚合、别名、JOIN、子查询、更新删除与 upsert', async () => {
  await plugin
    .insertInto('codes')
    .values([row('A1'), { ...row('A2', 2), status: 'used', used_by: 7 }, row('B1', 3)])
    .execute()
  await plugin.insertInto('logs').values({ code: 'A2', at: '2026-10-16T00:00:00Z' }).execute()
  expect(
    await plugin
      .selectFrom('codes')
      .select(['code', 'n'])
      .where('code', 'like', 'A%')
      .where('status', 'in', ['unused', 'used'])
      .orderBy('n', 'desc')
      .limit(10)
      .offset(0)
      .execute(),
  ).toEqual([
    { code: 'A2', n: 2 },
    { code: 'A1', n: 1 },
  ])
  const aggregate = await plugin
    .selectFrom('codes')
    .select((eb) => ['status', eb.fn.countAll().as('count'), eb.fn.sum('n').as('total')])
    .groupBy('status')
    .orderBy('status')
    .execute()
  expect(aggregate.map((r) => ({ status: r.status, count: Number(r.count), total: Number(r.total) }))).toEqual([
    { status: 'unused', count: 2, total: 4 },
    { status: 'used', count: 1, total: 2 },
  ])
  expect(
    await plugin
      .selectFrom('codes as c')
      .innerJoin('logs as l', 'l.code', 'c.code')
      .select(['c.code', 'l.at'])
      .execute(),
  ).toEqual([{ code: 'A2', at: '2026-10-16T00:00:00Z' }])
  expect(
    await plugin
      .selectFrom('codes as c')
      .leftJoin('logs as l', 'l.code', 'c.code')
      .select('c.code')
      .orderBy('c.code')
      .execute(),
  ).toEqual([{ code: 'A1' }, { code: 'A2' }, { code: 'B1' }])
  expect(
    await plugin
      .selectFrom('codes')
      .select('code')
      .where('code', 'in', (eb) => eb.selectFrom('logs').select('logs.code'))
      .execute(),
  ).toEqual([{ code: 'A2' }])
  expect(
    await plugin
      .selectFrom('codes as c')
      .select('c.code')
      .where((eb) => eb.not(eb.exists(eb.selectFrom('logs').select('logs.code').whereRef('logs.code', '=', 'c.code'))))
      .orderBy('c.code')
      .execute(),
  ).toEqual([{ code: 'A1' }, { code: 'B1' }])
  const insert = plugin.insertInto('codes').values(row('A2', 100))
  // 插件按实际方言构造 upsert，网关不改变语义。
  if (dialectOf(database.db) === 'mysql')
    await insert.onDuplicateKeyUpdate({ n: (eb) => eb.fn<number>('values', [eb.ref('n')]) }).execute()
  else await insert.onConflict((oc) => oc.column('code').doUpdateSet({ n: (eb) => eb.ref('excluded.n') })).execute()
  expect(await plugin.selectFrom('codes').select('n').where('code', '=', 'A2').execute()).toEqual([{ n: 100 }])
  expect(
    (await plugin.updateTable('codes').set({ status: 'used', used_by: 9 }).where('code', '=', 'B1').executeTakeFirst())
      .numUpdatedRows,
  ).toBe(1n)
  expect((await plugin.deleteFrom('codes').where('code', '=', 'A1').executeTakeFirst()).numDeletedRows).toBe(1n)
  const returning = plugin.insertInto('codes').values(row('RETURN'))
  // MySQL 没有 RETURNING；其余方言必须保留 INSERT RETURNING 的结果。
  if (dialectOf(database.db) !== 'mysql')
    expect(await returning.returning('code').execute()).toEqual([{ code: 'RETURN' }])
  else expect((await returning.executeTakeFirst()).numInsertedOrUpdatedRows).toBe(1n)
  expect(
    await plugin
      .selectFrom('codes')
      .select((eb) => eb.neg(eb.neg('n')).as('n'))
      .where('code', '=', 'A2')
      .execute(),
  ).toEqual([{ n: 100 }])
  const binary = structuredClone(
    plugin.selectFrom('codes').select('code').where('code', '=', 'anything').toOperationNode(),
  )
  Object.assign((binary.where!.where as unknown as { rightOperand: object }).rightOperand, {
    value: new Uint8Array(6000).fill(65),
  })
  expect(await gateway.execute(scope, binary)).toMatchObject({ rows: [] })
})

const tableNode = (name: string) => ({
  kind: 'TableNode',
  table: { kind: 'SchemableIdentifierNode', identifier: { kind: 'IdentifierNode', name } },
})
const column = (name: string) => ({ kind: 'ColumnNode', column: { kind: 'IdentifierNode', name } })
const valueNode = (value: unknown) => ({ kind: 'ValueNode', value })
const selectNode = () => ({
  kind: 'SelectQueryNode',
  from: { kind: 'FromNode', froms: [tableNode('codes')] },
  selections: [{ kind: 'SelectionNode', selection: { kind: 'SelectAllNode' } }],
})
const exprSelect = (selection: unknown) => ({ ...selectNode(), selections: [{ kind: 'SelectionNode', selection }] })
const updateNode = () => ({
  kind: 'UpdateQueryNode',
  table: tableNode('codes'),
  updates: [{ kind: 'ColumnUpdateNode', column: column('n'), value: valueNode(1) }],
})
const whereValue = (value: unknown) => ({
  ...selectNode(),
  where: {
    kind: 'WhereNode',
    where: {
      kind: 'BinaryOperationNode',
      leftOperand: column('code'),
      operator: { kind: 'OperatorNode', operator: '=' },
      rightOperand: valueNode(value),
    },
  },
})
const createNode = () => ({
  kind: 'CreateTableNode',
  table: tableNode('codes'),
  columns: [
    {
      kind: 'ColumnDefinitionNode',
      column: column('x'),
      dataType: { kind: 'DataTypeNode', dataType: 'integer); drop table users; --' },
    },
  ],
})
const fkNode = (table: string, action = 'restrict') => ({
  kind: 'CreateTableNode',
  table: tableNode('logs'),
  columns: [
    {
      kind: 'ColumnDefinitionNode',
      column: column('x'),
      dataType: { kind: 'DataTypeNode', dataType: 'integer' },
      references: { kind: 'ReferencesNode', table: tableNode(table), columns: [column('code')], onDelete: action },
    },
  ],
})
const joinNode = (table = 'logs', joinType = 'InnerJoin') => ({
  kind: 'JoinNode',
  joinType,
  table: tableNode(table),
  on: { kind: 'OnNode', on: valueNode(true) },
})

const attacks: [string, () => unknown, boolean?][] = [
  ['原始 SQL', () => sql`select * from users`.toOperationNode()],
  ['原始片段', () => ({ ...selectNode(), where: { kind: 'WhereNode', where: sql`1=1`.toOperationNode() } })],
  ['核心表', () => ({ ...selectNode(), from: { kind: 'FromNode', froms: [tableNode('users')] } })],
  ['读取核心设置', () => ({ ...selectNode(), from: { kind: 'FromNode', froms: [tableNode('settings')] } })],
  ['修改核心表', () => ({ ...updateNode(), table: tableNode('settings') })],
  ['删除核心数据', () => ({ kind: 'DeleteQueryNode', from: { kind: 'FromNode', froms: [tableNode('settings')] } })],
  ['未声明的表', () => ({ kind: 'InsertQueryNode', into: tableNode('evil') })],
  [
    'schema 限定',
    () => ({
      ...selectNode(),
      from: {
        kind: 'FromNode',
        froms: [
          {
            kind: 'TableNode',
            table: { ...tableNode('codes').table, schema: { kind: 'IdentifierNode', name: 'main' } },
          },
        ],
      },
    }),
  ],
  ['JOIN 核心表', () => ({ ...selectNode(), joins: [joinNode('users')] })],
  ['子查询核心表', () => exprSelect({ ...selectNode(), from: { kind: 'FromNode', froms: [tableNode('users')] } })],
  [
    '别名不能当来源',
    () => ({
      ...selectNode(),
      from: {
        kind: 'FromNode',
        froms: [{ kind: 'AliasNode', node: tableNode('codes'), alias: { kind: 'IdentifierNode', name: 'users' } }],
      },
      where: { kind: 'WhereNode', where: { ...selectNode(), from: { kind: 'FromNode', froms: [tableNode('users')] } } },
    }),
  ],
  ['非白名单函数', () => exprSelect({ kind: 'FunctionNode', func: 'load_extension', arguments: [valueNode('x')] })],
  ['sleep 函数', () => exprSelect({ kind: 'FunctionNode', func: 'pg_sleep', arguments: [valueNode(10)] })],
  ['立即值', () => exprSelect({ kind: 'ValueNode', value: 1, immediate: true })],
  ['DDL 非迁移', () => createNode()],
  ['删除核心表', () => ({ kind: 'DropTableNode', table: tableNode('users') }), true],
  ['外键核心表', () => fkNode('users'), true],
  [
    '核心索引',
    () => ({
      kind: 'CreateIndexNode',
      name: { kind: 'IdentifierNode', name: 'steal' },
      table: tableNode('users'),
      columns: [column('email')],
    }),
    true,
  ],
  [
    '伪造运算符',
    () => ({
      ...selectNode(),
      where: {
        kind: 'WhereNode',
        where: {
          kind: 'BinaryOperationNode',
          leftOperand: column('code'),
          operator: { kind: 'OperatorNode', operator: '= code union select email from users --' },
          rightOperand: valueNode('x'),
        },
      },
    }),
  ],
  ['伪造数据类型', () => createNode(), true],
  ['伪造标识符', () => exprSelect(column('code" from users --'))],
  ['CTE', () => ({ ...selectNode(), with: { kind: 'WithNode', expressions: [] } })],
  [
    '伪造排序',
    () => ({
      ...selectNode(),
      orderBy: {
        kind: 'OrderByNode',
        items: [
          {
            kind: 'OrderByItemNode',
            orderBy: column('code'),
            direction: { kind: 'RawNode', sqlFragments: ['desc; drop table users'], parameters: [] },
          },
        ],
      },
    }),
  ],
  ['列表过大', () => exprSelect({ kind: 'PrimitiveValueListNode', values: Array.from({ length: 1001 }, () => 'x') })],
  [
    '循环树',
    () => {
      const node: Record<string, unknown> = { kind: 'ParensNode' }
      node.node = node
      return exprSelect(node)
    },
  ],
  [
    '多个 FROM',
    () => ({ ...selectNode(), from: { kind: 'FromNode', froms: [tableNode('codes'), tableNode('logs')] } }),
  ],
  ['Date 参数', () => whereValue(new Date())],
  ['超大字符串', () => whereValue('x'.repeat(65537))],
  ['多字节字符串', () => whereValue('中'.repeat(22000))],
  ['超大二进制', () => whereValue(new Uint8Array(256 * 1024 + 1))],
  ['INSERT SELECT', () => ({ kind: 'InsertQueryNode', into: tableNode('codes'), values: selectNode() })],
  [
    'UPDATE RETURNING',
    () => ({ ...updateNode(), returning: { kind: 'ReturningNode', selections: selectNode().selections } }),
  ],
  [
    'DELETE RETURNING',
    () => ({
      kind: 'DeleteQueryNode',
      from: selectNode().from,
      returning: { kind: 'ReturningNode', selections: selectNode().selections },
    }),
  ],
  ['五个 JOIN', () => ({ ...selectNode(), joins: Array.from({ length: 5 }, () => joinNode()) })],
  ['不支持的 JOIN', () => ({ ...selectNode(), joins: [joinNode('logs', 'CrossJoin')] })],
  [
    '窗口函数',
    () =>
      exprSelect({
        kind: 'AggregateFunctionNode',
        func: 'count',
        aggregated: [column('code')],
        over: { kind: 'OverNode' },
      }),
  ],
  [
    '不支持的聚合',
    () => exprSelect({ kind: 'AggregateFunctionNode', func: 'group_concat', aggregated: [column('code')] }),
  ],
  ['不支持的外键动作', () => fkNode('codes', 'set default'), true],
  [
    '过多节点',
    () => ({
      ...selectNode(),
      selections: Array.from({ length: 1000 }, () => ({
        kind: 'SelectionNode',
        selection: { kind: 'FunctionNode', func: 'coalesce', arguments: [valueNode(1), valueNode(2)] },
      })),
    }),
  ],
  [
    '总消息过大',
    () =>
      exprSelect({ kind: 'PrimitiveValueListNode', values: Array.from({ length: 20 }, () => 'x'.repeat(64 * 1024)) }),
  ],
  ...['ForUpdate', 'ForShare', 'NoWait', 'SkipLocked'].map((modifier): [string, () => unknown] => [
    modifier,
    () => ({ ...selectNode(), endModifiers: [{ kind: 'SelectModifierNode', modifier }] }),
  ]),
  ...['begin', 'commit', 'rollback'].map((kind): [string, () => unknown] => [kind, () => ({ kind })]),
]
test.each(attacks)('拒绝：%s', async (_name, make, allowDdl = false) => {
  await expect(gateway.execute({ ...scope, allowDdl }, structuredClone(make()))).rejects.toMatchObject({
    code: 'rejected',
  })
})

test('物理名碰撞和过长命名不能通过；Distinct 仍可用', async () => {
  for (const [id, name] of [
    ['a', 'b__c'],
    ['a__b', 'c'],
    ['Victim', 'codes'],
    ['a', 'Codes'],
    ['a'.repeat(60), 'codes'],
  ])
    expect(() => physicalName(id!, name!)).toThrow()
  await expect(
    gateway.execute({ ...scope, tables: new Set(['codes', 'bad__name']) }, selectNode()),
  ).rejects.toMatchObject({ code: 'rejected' })
  expect(await plugin.selectFrom('codes').select('status').distinct().execute()).toHaveLength(2)
})

test('约束错误和普通错误使用固定文案，日志不含值', async () => {
  await expect(plugin.insertInto('codes').values(row('A2')).execute()).rejects.toMatchObject({
    code: 'constraint',
    message: 'Plugin query constraint',
  })
  await expect(
    plugin.insertInto('logs').values({ code: 'missing', at: 'secret-value' }).execute(),
  ).rejects.toMatchObject({ code: 'constraint' })
  await expect(
    gateway.execute(scope, {
      kind: 'InsertQueryNode',
      into: tableNode('logs'),
      columns: [column('code'), column('at'), column('related')],
      values: { kind: 'ValuesNode', values: [{ kind: 'PrimitiveValueListNode', values: ['A2', 'x', 'missing'] }] },
    }),
  ).rejects.toMatchObject({ code: 'constraint' })
  const broken = structuredClone(plugin.insertInto('logs').values({ code: 'A2', at: 'x' }).toOperationNode())
  Object.assign((broken.values as unknown as { values: { values: unknown[] }[] }).values[0]!, { values: ['A2', null] })
  await expect(gateway.execute(scope, broken)).rejects.toMatchObject({ code: 'constraint' })
  await expect(gateway.execute(scope, exprSelect(column('missing_column')))).rejects.toMatchObject({
    code: 'failed',
    message: 'Plugin query failed',
  })
  expect(logs.join('\n')).not.toContain('secret-value')
  expect(logs.join('\n')).not.toContain('core-private-value')
})

test('拦截器语句随核心事务回滚、重跑或提交', async () => {
  const insert = structuredClone(plugin.insertInto('codes').values(row('TX')).toOperationNode())
  await expect(
    database.db.transaction().execute(async (trx) => {
      await gateway.execute({ ...scope, transaction: trx }, insert)
      expect(
        (
          await gateway.execute(
            { ...scope, transaction: trx },
            structuredClone(plugin.selectFrom('codes').select('code').where('code', '=', 'TX').toOperationNode()),
          )
        ).rows,
      ).toEqual([{ code: 'TX' }])
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await plugin.selectFrom('codes').select('code').where('code', '=', 'TX').execute()).toEqual([])
  await database.db.transaction().execute(async (trx) => {
    await gateway.execute({ ...scope, transaction: trx }, insert)
  })
  expect(await plugin.selectFrom('codes').select('code').where('code', '=', 'TX').execute()).toEqual([{ code: 'TX' }])
})

test('LIMIT 下推，10001 行被拒绝，OFFSET 和过大 LIMIT 同样受限', async () => {
  for (let start = 0; start < 10_001; start += 500)
    await plugin
      .insertInto('numbers')
      .values(Array.from({ length: Math.min(500, 10_001 - start) }, (_, i) => ({ n: start + i })))
      .execute()
  for (const query of [
    plugin.selectFrom('numbers').selectAll(),
    plugin.selectFrom('numbers').selectAll().limit(20000),
    plugin.selectFrom('numbers').selectAll().offset(0),
  ]) {
    const compiled = compilePluginQuery(
      database.db,
      sanitizePluginQuery(structuredClone(query.toOperationNode()), scope),
      Date.now() + 1000,
    )
    expect(compiled.sql.toLowerCase()).toContain('limit')
    expect(compiled.parameters).toContain(10_001)
    await expect(query.execute()).rejects.toMatchObject({ code: 'rejected' })
  }
  expect(await plugin.selectFrom('numbers').selectAll().limit(10_000).execute()).toHaveLength(10_000)
  expect(await plugin.selectFrom('numbers').selectAll().limit(3).offset(2).execute()).toHaveLength(3)
})

function slowQuery() {
  const source = plugin.selectFrom('numbers').selectAll().limit(80)
  return plugin
    .selectFrom(source.as('a'))
    .innerJoin(source.as('b'), (j) => j.on((eb) => eb.val(true)))
    .innerJoin(source.as('c'), (j) => j.on((eb) => eb.val(true)))
    .innerJoin(source.as('d'), (j) => j.on((eb) => eb.val(true)))
    .select((eb) => eb.fn.sum(eb('a.n', '+', eb('b.n', '+', eb('c.n', '+', eb.ref('d.n'))))).as('total'))
    .toOperationNode()
}

test('慢 SELECT 按期限中止，核心随后正常查询', async () => {
  const start = performance.now()
  await expect(gateway.execute({ ...scope, timeoutMs: 50 }, structuredClone(slowQuery()))).rejects.toMatchObject({
    code: 'timeout',
  })
  expect(performance.now() - start).toBeLessThan(2000)
  expect(await database.db.selectFrom('users').selectAll().execute()).toEqual([])
  expect(await plugin.selectFrom('codes').select('code').limit(1).execute()).toHaveLength(1)
})

test('慢写语句也能中止，失败后核心连接仍可用', async () => {
  const slow = { ...updateNode(), updates: [{ kind: 'ColumnUpdateNode', column: column('n'), value: slowQuery() }] }
  const start = performance.now()
  await expect(gateway.execute({ ...scope, timeoutMs: 50 }, structuredClone(slow))).rejects.toMatchObject({
    code: 'timeout',
  })
  expect(performance.now() - start).toBeLessThan(2000)
  expect(await database.db.selectFrom('users').selectAll().execute()).toEqual([])
  expect(await database.db.selectFrom('settings').selectAll().where('key', '=', sentinel.key).execute()).toEqual([
    sentinel,
  ])
})

test('返回值可结构化克隆，消息超过 8 MiB 被拒绝', async () => {
  const query = plugin
    .selectFrom('numbers')
    .select((eb) => eb.val('x'.repeat(60_000)).as('payload'))
    .limit(150)
  await expect(query.execute()).rejects.toMatchObject({ code: 'rejected' })
  const result = await gateway.execute(
    scope,
    structuredClone(plugin.selectFrom('numbers').selectAll().limit(2).toOperationNode()),
  )
  expect(structuredClone(result)).toEqual(result)
  expect(Object.getPrototypeOf(result.rows[0])).toBe(Object.prototype)
})

test('核心事务里的慢 SELECT 回滚后，核心仍可继续查询', async () => {
  await expect(
    database.db.transaction().execute(async (trx) => {
      await gateway.execute({ ...scope, transaction: trx, timeoutMs: 50 }, structuredClone(slowQuery()))
    }),
  ).rejects.toMatchObject({ code: 'timeout' })
  expect(await database.db.selectFrom('settings').selectAll().where('key', '=', sentinel.key).execute()).toEqual([
    sentinel,
  ])
})

test('同一核心事务内的并发插件查询不覆盖彼此的超时', async () => {
  let elapsed = Infinity
  let short: PromiseSettledResult<unknown> | undefined
  const start = performance.now()
  await expect(
    database.db.transaction().execute(async (trx) => {
      const results = await Promise.allSettled([
        gateway.execute({ ...scope, transaction: trx, timeoutMs: 50 }, structuredClone(slowQuery())).finally(() => {
          elapsed = performance.now() - start
        }),
        gateway.execute(
          { ...scope, transaction: trx, timeoutMs: 2000 },
          structuredClone(plugin.selectFrom('codes').select('code').limit(1).toOperationNode()),
        ),
      ])
      short = results[0]
      throw new Error('rollback parallel queries')
    }),
  ).rejects.toThrow('rollback parallel queries')
  expect(short).toMatchObject({ status: 'rejected', reason: { code: 'timeout' } })
  expect(elapsed).toBeLessThan(1000)
  expect(await database.db.selectFrom('settings').selectAll().where('key', '=', sentinel.key).execute()).toEqual([
    sentinel,
  ])
})

test('核心表数据完好；卸载删除有外键且非空的表，重复卸载安全', async () => {
  expect(await database.db.selectFrom('users').selectAll().execute()).toEqual([])
  expect(await database.db.selectFrom('settings').selectAll().where('key', '=', sentinel.key).execute()).toEqual([
    sentinel,
  ])
  await gateway.dropTables(scope.pluginId, ['codes', 'logs', 'numbers'])
  await gateway.dropTables(scope.pluginId, ['codes', 'logs', 'numbers'])
  expect((await database.db.introspection.getTables()).map((t) => t.name)).not.toContain(
    physicalName(scope.pluginId, 'codes'),
  )
  expect(await database.db.selectFrom('users').selectAll().execute()).toEqual([])
  expect(await database.db.selectFrom('settings').selectAll().where('key', '=', sentinel.key).execute()).toEqual([
    sentinel,
  ])
})
