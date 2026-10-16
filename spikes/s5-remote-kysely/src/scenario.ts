/**
 * S5 端到端场景：真实的子进程边界（node --permission，空环境变量），三种数据库。
 * 用法：DB=sqlite|postgres|mysql npx tsx src/scenario.ts
 */
import { NodeSqliteDialect } from '@better-auth/kysely-adapter/node-sqlite-dialect'
import { Kysely, MysqlDialect, PostgresDialect, sql } from 'kysely'
import { createPool } from 'mysql2'
import assert from 'node:assert/strict'
import { type ChildProcess, fork } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { PluginDbGateway } from './gateway'
import { PluginQueryRejected, physicalName } from './sanitize'

type Dialect = 'sqlite' | 'postgres' | 'mysql'
const dialect = (process.env.DB ?? 'sqlite') as Dialect
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function createDb(): Kysely<any> {
  if (dialect === 'sqlite') return new Kysely({ dialect: new NodeSqliteDialect({ database: new DatabaseSync(':memory:') }) })
  if (dialect === 'postgres')
    return new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.PG_URL, max: 5 }) }) })
  return new Kysely({ dialect: new MysqlDialect({ pool: createPool({ uri: process.env.MYSQL_URL, connectionLimit: 5 }) }) })
}

const db = createDb()
if (dialect !== 'sqlite') {
  if (dialect === 'mysql') await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db)
  const cascade = dialect === 'postgres' ? sql` cascade` : sql``
  for (const t of await db.introspection.getTables()) await sql`drop table if exists ${sql.table(t.name)}${cascade}`.execute(db)
  if (dialect === 'mysql') await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db)
}
await db.schema
  .createTable('users')
  .addColumn('id', 'integer', (col) => col.primaryKey())
  .addColumn('email', 'varchar(64)')
  .addColumn('password', 'varchar(64)')
  .execute()
await db.insertInto('users').values({ id: 1, email: 'admin@site', password: 'SECRET-HASH' }).execute()

const gateway = new PluginDbGateway(
  db,
  { id: 'invites', tables: new Set(['codes', 'logs']) },
  { maxConcurrentTransactions: 2, transactionTimeoutMs: 500 },
)

// 一个核心才有的"秘密文件"，插件进程不应读到
const secretPath = join(root, 'secret', 'core.env')
mkdirSync(dirname(secretPath), { recursive: true })
writeFileSync(secretPath, 'DATABASE_URL=mysql://root:hunter2@db/core\n')

// ---------------------------------------------------------------- 启动插件 host

const child: ChildProcess = fork(join(root, 'src', 'host.ts'), [dialect], {
  execArgv: [
    '--permission',
    `--allow-fs-read=${join(root, 'src')}`,
    `--allow-fs-read=${join(root, 'node_modules')}`,
    `--allow-fs-read=${join(root, 'package.json')}`,
    '--disable-warning=ExperimentalWarning',
  ],
  env: {},
  serialization: 'advanced',
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
})

const calls = new Map<number, (result: { ok: boolean; value?: any; error?: string }) => void>()
let sequence = 0
await new Promise<void>((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code) => reject(new Error(`host exited with ${code}`)))
  child.on('message', (message: any) => {
    if (message.type === 'ready') resolve()
    else if (message.type === 'result') {
      calls.get(message.id)?.(message)
      calls.delete(message.id)
    } else if (message.type === 'db') {
      gateway.handle(message.request, message.invocationId).then(
        (value) => child.send({ type: 'dbResult', id: message.id, ok: true, value }),
        (error: Error) =>
          child.send({
            type: 'dbResult',
            id: message.id,
            ok: false,
            error: error instanceof PluginQueryRejected ? `REJECTED: ${error.message}` : `DB ERROR: ${error.message}`,
          }),
      )
    }
  })
})

function call(op: string, args: unknown = {}, options: Parameters<PluginDbGateway['invoke']>[0] = {}) {
  return gateway.invoke(options, (invocationId) => {
    const id = ++sequence
    child.send({ type: 'call', id, op, args, invocationId })
    return new Promise<{ ok: boolean; value?: any; error?: string }>((resolve) => calls.set(id, resolve))
  })
}

// ---------------------------------------------------------------- 检查

const results: { name: string; ok: boolean; detail?: string }[] = []
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail || undefined })
  } catch (error) {
    results.push({ name, ok: false, detail: (error as Error).message })
  }
}
async function expectOk(op: string, args?: unknown, options?: Parameters<PluginDbGateway['invoke']>[0]) {
  const result = await call(op, args, options)
  assert.ok(result.ok, `${op} failed: ${result.error}`)
  return result.value
}
async function expectRejected(op: string, options?: Parameters<PluginDbGateway['invoke']>[0]) {
  const result = await call(op, {}, options)
  assert.ok(!result.ok, `${op} was NOT rejected: ${JSON.stringify(result.value)?.slice(0, 200)}`)
  assert.match(String(result.error), /REJECTED/, `${op} failed for another reason: ${result.error}`)
  return String(result.error).replace(/^REJECTED: /, '')
}

await check('迁移：在迁移调用里建表/建索引，物理表名带插件前缀', async () => {
  assert.equal(await expectOk('migrate', {}, { allowDdl: true }), 'ok')
  const tables = (await db.introspection.getTables()).map((t) => t.name).sort()
  assert.deepEqual(tables, ['p_invites__codes', 'p_invites__logs', 'users'])
})

await check('插入与排序查询', async () => {
  assert.deepEqual(await expectOk('insertCodes'), ['A1', 'A2', 'B1'])
  assert.deepEqual(await expectOk('selectFiltered'), [
    { code: 'A2', n: 2 },
    { code: 'A1', n: 1 },
  ])
})

await check('聚合与分组', async () => {
  assert.deepEqual(await expectOk('aggregate'), [
    { status: 'unused', count: 2, total: 4 },
    { status: 'used', count: 1, total: 2 },
  ])
})

await check('别名与 JOIN（插件自己的两张表）', async () => {
  assert.deepEqual(await expectOk('joinWithAliases'), [{ code: 'A2', at: '2026-10-16T00:00:00Z' }])
})

await check('子查询：in 与相关子查询 not exists', async () => {
  assert.deepEqual(await expectOk('subqueries'), { inLogs: ['A2'], withoutLogs: ['A1', 'B1'] })
})

await check('upsert（onConflict / onDuplicateKeyUpdate）', async () => {
  assert.equal(await expectOk('upsert', { dialect }), 100)
})

await check('更新与删除', async () => {
  assert.deepEqual(await expectOk('updateAndDelete'), { updated: 1, deleted: 1 })
})

await check('插件自己的事务：提交生效，回滚无痕', async () => {
  assert.deepEqual(await expectOk('pluginTransaction'), ['T1'])
})

await check('拦截器加入核心事务：核心回滚时插件写入一起回滚', async () => {
  await db
    .transaction()
    .execute(async (trx) => {
      await trx.insertInto('users').values({ id: 2, email: 'new@site', password: 'x' }).execute()
      assert.equal(await expectOk('hookWrite', { code: 'HOOK1' }, { coreTransaction: trx }), 'written')
      throw new Error('core aborts registration')
    })
    .catch((error) => {
      if (!String(error.message).includes('core aborts')) throw error
    })
  assert.equal(await expectOk('count', { code: 'HOOK1' }), 0)
  const users = await db.selectFrom('users').select('id').execute()
  assert.equal(users.length, 1)
})

await check('拦截器加入核心事务：核心提交时插件写入一起提交', async () => {
  await db.transaction().execute(async (trx) => {
    await expectOk('hookWrite', { code: 'HOOK2' }, { coreTransaction: trx })
  })
  assert.equal(await expectOk('count', { code: 'HOOK2' }), 1)
})

const attacks: [string, Parameters<PluginDbGateway['invoke']>[0]?][] = [
  ['attackCoreTable'],
  ['attackRawSql'],
  ['attackRawFragment'],
  ['attackSchemaQualified'],
  ['attackSqliteMaster'],
  ['attackJoinCore'],
  ['attackSubqueryCore'],
  ['attackAliasAsSource'],
  ['attackFunction'],
  ['attackSleep'],
  ['attackLiteral'],
  ['attackDdlOutsideMigration'],
  ['attackUndeclaredTable'],
  ['attackDropCoreTable', { allowDdl: true }],
  ['attackForeignKeyToCore', { allowDdl: true }],
  ['attackIndexOnCore', { allowDdl: true }],
  ['attackForgedDataType', { allowDdl: true }],
  ['attackForgedOperator'],
  ['attackForgedIdentifier'],
  ['attackForgedExtraField'],
  ['attackForgedRawDirection'],
  ['attackHugeList'],
  ['attackCyclicTree'],
  // 回归：独立审核发现的问题
  ['attackCommaJoin'],
  ['attackDateParam'],
  ['attackHugeString'],
  ['attackInsertSelect'],
  ['attackUpdateReturning'],
]
for (const [op, options] of attacks) {
  await check(`拒绝：${op}${options?.allowDdl ? '（迁移上下文）' : ''}`, async () => expectRejected(op, options))
}

await check('回归：嵌套一元负号不会编译成 SQL 注释', async () => {
  assert.equal(await expectOk('doubleNegation'), 100)
})

await check('回归：二进制参数不会被当成节点计数', async () => {
  assert.equal(await expectOk('binaryParam'), 0)
})

await check('回归：并发开启事务时名额上限精确生效，超出的请求立即被拒绝', async () => {
  // 上限设为 1：SQLite 只有一个连接，第二个事务本来就会排队等待，上限为 1 时三种数据库行为一致
  const limited = new PluginDbGateway(db, { id: 'invites', tables: new Set(['codes']) }, { maxConcurrentTransactions: 1, transactionTimeoutMs: 2000 })
  const start = performance.now()
  const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => limited.handle({ kind: 'begin' }, undefined)))
  const elapsed = performance.now() - start
  const accepted = outcomes.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<unknown>[]
  assert.equal(accepted.length, 1)
  assert.ok(elapsed < 1000, `rejections were not immediate: ${elapsed.toFixed(0)} ms`)
  await limited.handle({ kind: 'rollback', txId: accepted[0]!.value as string }, undefined)
})

await check('回归：物理名在插件之间不可能冲突（插件 id 与表名格式）', async () => {
  const make = (id: string, tables: string[]) => () => new PluginDbGateway(db, { id, tables: new Set(tables) })
  assert.throws(make('a__b', ['c']), PluginQueryRejected)
  assert.throws(make('a', ['b__c']), PluginQueryRejected)
  assert.throws(make('Victim', ['codes']), PluginQueryRejected)
  assert.throws(make('a', ['Codes']), PluginQueryRejected)
  assert.throws(make('a-', ['codes']), PluginQueryRejected)
  assert.doesNotThrow(make('invite-codes', ['codes', 'usage_log']))
  assert.equal(physicalName('invite-codes', 'usage_log'), 'p_invite_codes__usage_log')
})

await check('回归：事务超过期限后不能提交（同步阻塞让超时定时器没来得及触发）', async () => {
  const strict = new PluginDbGateway(db, { id: 'invites', tables: new Set(['codes']) }, { maxConcurrentTransactions: 1, transactionTimeoutMs: 20 })
  const txId = (await strict.handle({ kind: 'begin' }, undefined)) as string
  const end = Date.now() + 60
  while (Date.now() < end) {} // 模拟一条同步执行的慢查询占住事件循环
  await assert.rejects(strict.handle({ kind: 'commit', txId }, undefined), /time limit/)
})

await check('挂起的插件事务超时自动回滚，连接被释放', async () => {
  const before = gateway.stats.autoRolledBack
  await expectOk('attackHangingTransaction')
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(gateway.stats.autoRolledBack - before, 1)
  assert.equal(await expectOk('count', { code: 'HANG' }), 0)
})

await check('核心数据完好：users 表未被读取或修改', async () => {
  // node:sqlite 返回无原型对象，展开成普通对象再比较
  const rows = (await db.selectFrom('users').selectAll().execute()).map((row) => ({ ...row }))
  assert.deepEqual(rows, [{ id: 1, email: 'admin@site', password: 'SECRET-HASH' }])
  const tables = (await db.introspection.getTables()).map((t) => t.name).sort()
  assert.deepEqual(tables, ['p_invites__codes', 'p_invites__logs', 'users'])
})

await check('进程安全带：插件读不到核心的文件和环境变量', async () => {
  const file = await call('readSecretFile', { path: secretPath })
  assert.ok(!file.ok && /ERR_ACCESS_DENIED|permission/i.test(String(file.error)), `read result: ${JSON.stringify(file)}`)
  assert.equal(await expectOk('readEnv'), null)
})

await check('性能：经过 IPC + 重建 + 重新编译的单条查询耗时', async () => {
  const n = 500
  const viaPlugin = (await expectOk('bench', { n })) as number
  const start = performance.now()
  for (let i = 0; i < n; i++) await db.selectFrom('p_invites__codes').select('code').where('code', '=', 'A2').execute()
  const direct = (performance.now() - start) / n
  return `插件 ${viaPlugin.toFixed(3)} ms/次，核心直连 ${direct.toFixed(3)} ms/次`
})

console.log(`\n== S5 / ${dialect} ==`)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`)
console.log(`gateway stats: ${JSON.stringify(gateway.stats)}`)
child.kill()
await db.destroy()
process.exit(results.every((r) => r.ok) ? 0 : 1)
