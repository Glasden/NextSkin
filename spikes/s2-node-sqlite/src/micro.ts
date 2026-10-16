/**
 * 单条查询的开销：驱动本身、Kysely 层、worker 往返分别占多少。
 *
 *   node src/micro.ts <db 文件>
 *
 * 读：CSL 查询（players 左连接两次 textures，按角色名查）。写：一个事务内插入一行再更新一行。
 * "串行"是一条接一条 await；"并发 32"是同时保持 32 条在途，看吞吐。
 */
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { NodeSqliteDialect } from '@better-auth/kysely-adapter/node-sqlite-dialect'
import { CORE_PRAGMAS, wrapNodeSqlite } from './db/node-sqlite.ts'
import { PoolDialect, WriterState, mainBackend, workerBackend } from './db/pool-dialect.ts'
import { SIZES, type DB } from './schema.ts'

const file = process.argv[2]!
const require = createRequire(import.meta.url)
const N = 20_000
const name = (i: number) => `p${1 + ((i * 7919) % SIZES.players)}`
const RAW_SQL =
  'select p.name, s.hash as skin, s.type as model, k.hash as cape from players as p left join textures as s on s.tid = p.tid_skin left join textures as k on k.tid = p.tid_cape where p.name = ?'

function open() {
  const db = new DatabaseSync(file, { timeout: 5000 })
  for (const p of CORE_PRAGMAS) db.exec(p)
  return db
}
function report(label: string, ms: number, n = N) {
  console.log(`| ${label} | ${((ms * 1000) / n).toFixed(1)} | ${Math.round((n / ms) * 1000)} |`)
}
async function time(fn: () => Promise<void> | void) {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}
const cslQuery = (db: Kysely<DB>, i: number) =>
  db
    .selectFrom('players as p')
    .leftJoin('textures as s', 's.tid', 'p.tid_skin')
    .leftJoin('textures as k', 'k.tid', 'p.tid_cape')
    .select(['p.name', 's.hash as skin', 's.type as model', 'k.hash as cape'])
    .where('p.name', '=', name(i))
    .executeTakeFirst()

async function serial(db: Kysely<DB>) {
  for (let i = 0; i < N; i++) await cslQuery(db, i)
}
async function concurrent(db: Kysely<DB>, inflight = 32) {
  let i = 0
  await Promise.all(
    Array.from({ length: inflight }, async () => {
      while (i < N) await cslQuery(db, i++)
    }),
  )
}
let txSeq = 0
async function txWrites(db: Kysely<DB>, n: number) {
  for (let i = 0; i < n; i++) {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('likes').values({ uid: 1_000_000 + txSeq++, tid: 1 }).execute()
      await trx.updateTable('textures').set({ likes: sql`likes + 1` }).where('tid', '=', 1).execute()
    })
  }
}

console.log(`Node ${process.version}，每项 ${N} 次`)
console.log('| 方式 | 每次 µs | 每秒 |')
console.log('|---|---|---|')

// 1. 驱动直连（预编译语句复用）
{
  const db = open()
  const st = db.prepare(RAW_SQL)
  for (let i = 0; i < 2000; i++) st.get(name(i))
  report('node:sqlite 直连', await time(() => { for (let i = 0; i < N; i++) st.get(name(i)) }))
  db.close()
}
{
  const Better = require('better-sqlite3')
  const db = new Better(file)
  db.pragma('journal_mode = wal')
  const st = db.prepare(RAW_SQL)
  for (let i = 0; i < 2000; i++) st.get(name(i))
  report('better-sqlite3 直连', await time(() => { for (let i = 0; i < N; i++) st.get(name(i)) }))
  db.close()
}

// 2. Kysely 各种接法
const variants: [string, () => Kysely<DB>][] = [
  ['Kysely + SqliteDialect + 本适配层（模式 A）', () => new Kysely<DB>({ dialect: new SqliteDialect({ database: wrapNodeSqlite(open()) }) })],
  ['Kysely + Better Auth NodeSqliteDialect（每次 prepare）', () => new Kysely<DB>({ dialect: new NodeSqliteDialect({ database: open() }) })],
  [
    'Kysely + better-sqlite3',
    () => {
      const Better = require('better-sqlite3')
      const d = new Better(file)
      d.pragma('journal_mode = wal')
      return new Kysely<DB>({ dialect: new SqliteDialect({ database: d }) })
    },
  ],
  [
    'Kysely + PoolDialect，主线程读连接（模式 B）',
    () => new Kysely<DB>({ dialect: new PoolDialect({ writer: new WriterState(mainBackend(file, false)), readers: [mainBackend(file, true)], ownsWriter: true }) }),
  ],
  [
    'Kysely + PoolDialect，1 个 worker 读连接',
    () =>
      new Kysely<DB>({
        dialect: new PoolDialect({ writer: new WriterState(mainBackend(file, false)), readers: [workerBackend({ file, role: 'reader', busyTimeoutMs: 5000 })], ownsWriter: true }),
      }),
  ],
  [
    'Kysely + PoolDialect，2 个 worker 读连接（模式 C）',
    () =>
      new Kysely<DB>({
        dialect: new PoolDialect({
          writer: new WriterState(mainBackend(file, false)),
          readers: [workerBackend({ file, role: 'reader', busyTimeoutMs: 5000 }), workerBackend({ file, role: 'reader', busyTimeoutMs: 5000 })],
          ownsWriter: true,
        }),
      }),
  ],
  [
    'Kysely + PoolDialect，写连接在 worker（模式 D 的写）',
    () =>
      new Kysely<DB>({
        dialect: new PoolDialect({ writer: new WriterState(workerBackend({ file, role: 'writer', busyTimeoutMs: 5000 })), readers: [], ownsWriter: true }),
      }),
  ],
]
for (const [label, make] of variants) {
  const db = make()
  await concurrent(db) // 预热
  report(`${label}，读，串行`, await time(() => serial(db)))
  report(`${label}，读，并发 32`, await time(() => concurrent(db)))
  report(`${label}，写事务（2 条语句），串行`, await time(() => txWrites(db, 2000)), 2000)
  await db.destroy()
}
