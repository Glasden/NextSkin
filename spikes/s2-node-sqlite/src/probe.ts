/**
 * node:sqlite 功能探测：逐项打印核心会依赖的行为。在 Node 24 和 Node 26 上各跑一次。
 *
 *   node --experimental-strip-types src/probe.ts   （Node 24 默认已开启类型剥离，可省略参数）
 */
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as sqlite from 'node:sqlite'

const warnings: string[] = []
process.on('warning', (w) => warnings.push(`${w.name}: ${w.message}`))

const DatabaseCtor: typeof sqlite.DatabaseSync = (sqlite as any).Database ?? sqlite.DatabaseSync
const dir = join(import.meta.dirname, '..', 'data', `probe-${process.version}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const file = join(dir, 'probe.db')

const results: [string, string][] = []
function check(name: string, fn: () => unknown) {
  try {
    const v = fn()
    results.push([name, typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))])
  } catch (e: any) {
    results.push([name, `抛错 ${e.code ?? ''} ${String(e.message).split('\n')[0]}`])
  }
}

const db = new DatabaseCtor(file, { timeout: 2000 })
check('Node / SQLite 版本', () => `${process.version} / ${(db.prepare('select sqlite_version() v').get() as any).v}`)
check('类名', () => ((sqlite as any).Database ? 'Database（DatabaseSync 为别名）' : 'DatabaseSync'))
check('journal_mode=WAL', () => db.prepare('pragma journal_mode = wal').get())
check('synchronous 默认值', () => db.prepare('pragma synchronous').get())
db.exec('pragma synchronous = normal')
check('foreign_keys 默认值', () => db.prepare('pragma foreign_keys').get())
check('busy_timeout（构造参数 timeout=2000）', () => db.prepare('pragma busy_timeout').get())
check('编译选项（节选）', () =>
  (db.prepare('pragma compile_options').all() as any[])
    .map((r) => r.compile_options)
    .filter((o: string) => /THREADSAFE|FTS|JSON|RTREE|MATH|DEFAULT_WAL|DEFAULT_CACHE|MAX_|ENABLE_DBSTAT|SESSION|COLUMN_METADATA/.test(o))
    .join(' '),
)

db.exec(`create table t (id integer primary key, s text, n integer, b blob, r real) strict`)
const ins = db.prepare('insert into t (s, n, b, r) values (?, ?, ?, ?)')
check('绑定 boolean', () => ins.run('x', true as any, null, null))
check('绑定 Date', () => ins.run('x', new Date() as any, null, null))
check('绑定 undefined', () => ins.run('x', undefined as any, null, null))
check('绑定 bigint 2^62', () => ins.run('x', 2n ** 62n, null, null))
check('读取 2^62（readBigInts=false）', () => db.prepare('select n from t where n > 1000').get())
check('读取 2^62（setReadBigInts(true)）', () => {
  const s = db.prepare('select n from t where n > 1000')
  s.setReadBigInts(true)
  return s.get()
})
check('绑定 Uint8Array / Buffer', () => ins.run('x', 1, new Uint8Array([1, 2, 3]), 1.5))
check('读取 blob 的类型', () => {
  const row = db.prepare('select b from t where b is not null').get() as any
  return `${row.b.constructor.name}(${row.b.length})`
})
check('run() 返回值', () => ins.run('y', 2, null, null))
check('columns().length（select / insert）', () => [
  db.prepare('select 1 a, 2 b').columns().length,
  db.prepare('insert into t (s) values (?)').columns().length,
  db.prepare('insert into t (s) values (?) returning id').columns().length,
])
check('isTransaction', () => {
  db.exec('begin')
  const inside = (db as any).isTransaction
  db.exec('rollback')
  return { inside, after: (db as any).isTransaction }
})

// 防御性设置
check('defensive 默认开启（写 sqlite_master 应被拒）', () => {
  db.exec('pragma writable_schema = on')
  return db.prepare(`update sqlite_master set sql = sql where name = 't'`).run()
})
check('allowExtension 默认关闭（load_extension）', () => db.prepare(`select load_extension('x')`).get())
check('limits 属性', () => {
  const l = (db as any).limits
  return l ? { length: l.length, sqlLength: l.sqlLength, exprDepth: l.exprDepth, variableNumber: l.variableNumber } : '不支持'
})

// authorizer：插件连接的第二道防线
check('setAuthorizer 拒绝读未授权的表', () => {
  const adb = new DatabaseCtor(file, { readOnly: true })
  db.exec('create table if not exists p_demo__codes (code text primary key) strict')
  db.exec('create table if not exists users (uid integer primary key, password text) strict')
  const C = sqlite.constants as any
  adb.setAuthorizer((action: number, a1: string | null) => {
    if (action === C.SQLITE_READ || action === C.SQLITE_UPDATE || action === C.SQLITE_INSERT || action === C.SQLITE_DELETE) {
      return a1 && (a1.startsWith('p_demo__') || a1 === 'sqlite_master') ? C.SQLITE_OK : C.SQLITE_DENY
    }
    if (action === C.SQLITE_SELECT || action === C.SQLITE_FUNCTION || action === C.SQLITE_TRANSACTION) return C.SQLITE_OK
    return C.SQLITE_DENY
  })
  const out: Record<string, string> = {}
  for (const q of ['select * from p_demo__codes', 'select * from users', 'select * from p_demo__codes join users on 1=1', 'pragma table_info(users)', `attach 'x.db' as x`]) {
    try {
      adb.prepare(q).all()
      out[q] = '允许'
    } catch (e: any) {
      out[q] = `拒绝（${String(e.message).split('\n')[0]}）`
    }
  }
  adb.close()
  return out
})

// 在线备份
check('backup() 在线备份', () => {
  for (let i = 0; i < 2000; i++) ins.run(`row${i}`, i, null, null)
  const target = join(dir, 'backup.db')
  const p = (sqlite as any).backup(db, target)
  if (!(p instanceof Promise)) return '同步返回'
  return 'Promise（异步，下方打印结果）'
})
const backupPromise: Promise<unknown> = (sqlite as any).backup(db, join(dir, 'backup2.db'), { rate: 50 })

// 语句统计（Node 26 新增）
check('statement.stat(fullscanStep)', () => {
  const s = db.prepare('select count(*) from t where s = ?')
  s.get('row1')
  return (s as any).stat ? (s as any).stat('fullscanStep') : '不支持'
})
check('createTagStore（语句缓存）', () => (typeof (db as any).createTagStore === 'function' ? '支持' : '不支持'))

// 多连接：WAL 下读写并发、写写冲突
check('WAL：写事务进行中，另一连接可读到提交前的快照', () => {
  const r = new DatabaseCtor(file)
  db.exec('begin immediate')
  db.prepare('insert into t (s) values (?)').run('uncommitted')
  const seen = (r.prepare(`select count(*) c from t where s = 'uncommitted'`).get() as any).c
  db.exec('commit')
  const after = (r.prepare(`select count(*) c from t where s = 'uncommitted'`).get() as any).c
  r.close()
  return { 提交前: seen, 提交后: after }
})
check('写写冲突：busy_timeout=200ms 时第二个写者的等待与报错', () => {
  const w2 = new DatabaseCtor(file, { timeout: 200 })
  db.exec('begin immediate')
  const t0 = performance.now()
  let err = ''
  try {
    w2.exec('begin immediate')
  } catch (e: any) {
    err = `${e.code ?? ''} errcode=${e.errcode ?? ''} ${String(e.message)}`
  }
  const waited = Math.round(performance.now() - t0)
  db.exec('rollback')
  w2.close()
  return { 等待毫秒: waited, 错误: err }
})

await backupPromise.then(
  (v) => results.push(['backup(rate=50) 结果', `完成，返回 ${JSON.stringify(v)}，文件 ${statSync(join(dir, 'backup2.db')).size} 字节`]),
  (e) => results.push(['backup(rate=50) 结果', `失败 ${e.message}`]),
)
db.close()

for (const [k, v] of results) console.log(`- ${k}: ${v}`)
console.log(`- 进程警告: ${warnings.length ? warnings.join(' | ') : '无'}`)
