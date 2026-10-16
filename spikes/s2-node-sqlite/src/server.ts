/**
 * 基准用的 HTTP 服务：Hono + 模拟的核心读写路径 + 可选的"插件干扰"。
 *
 *   MODE=A|B|C|D|E  DB_FILE=...  INTERFERE=none|slow|tx  PORT=...  node src/server.ts
 *
 * 模式：
 *   A  单连接，主线程（Kysely 自带 SqliteDialect + 薄适配层；即"默认做法"）
 *   B  主线程一写一读两个连接
 *   C  写连接在主线程，2 个读连接在 worker
 *   D  写连接和 2 个读连接都在 worker
 *   E  同 B；插件的读查询另走一个装了 authorizer 的 worker 连接
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { CORE_PRAGMAS, wrapNodeSqlite } from './db/node-sqlite.ts'
import { type Backend, PoolDialect, WriterState, mainBackend, workerBackend } from './db/pool-dialect.ts'
import type { DB } from './schema.ts'

const MODE = process.env.MODE ?? 'A'
const FILE = process.env.DB_FILE!
const INTERFERE = process.env.INTERFERE ?? 'none'
const PORT = Number(process.env.PORT ?? 3100)
/** 插件慢查询的规模：两张各 N 行的子集做非等值连接，没有索引可用 */
const SLOW_N = Number(process.env.SLOW_N ?? 2500)
const TX_HOLD_MS = Number(process.env.TX_HOLD_MS ?? 200)

function build(): { core: Kysely<DB>; plugin: Kysely<DB> } {
  const worker = (role: 'writer' | 'reader' | 'plugin'): Backend =>
    workerBackend({ file: FILE, role, busyTimeoutMs: 5000, tablePrefix: role === 'plugin' ? 'p_demo__' : undefined })
  switch (MODE) {
    case 'A': {
      const db = new DatabaseSync(FILE, { timeout: 5000 })
      for (const p of CORE_PRAGMAS) db.exec(p)
      const core = new Kysely<DB>({ dialect: new SqliteDialect({ database: wrapNodeSqlite(db) }) })
      return { core, plugin: core }
    }
    case 'B':
    case 'E': {
      const writer = new WriterState(mainBackend(FILE, false))
      const core = new Kysely<DB>({ dialect: new PoolDialect({ writer, readers: [mainBackend(FILE, true)], ownsWriter: true }) })
      if (MODE === 'B') return { core, plugin: core }
      const plugin = new Kysely<DB>({ dialect: new PoolDialect({ writer, readers: [worker('plugin')], ownsWriter: false }) })
      return { core, plugin }
    }
    case 'C': {
      const writer = new WriterState(mainBackend(FILE, false))
      const core = new Kysely<DB>({ dialect: new PoolDialect({ writer, readers: [worker('reader'), worker('reader')], ownsWriter: true }) })
      return { core, plugin: core }
    }
    case 'D': {
      const writer = new WriterState(worker('writer'))
      const core = new Kysely<DB>({ dialect: new PoolDialect({ writer, readers: [worker('reader'), worker('reader')], ownsWriter: true }) })
      return { core, plugin: core }
    }
    default:
      throw new Error(`未知模式 ${MODE}`)
  }
}

const { core: db, plugin: pluginDb } = build()
const app = new Hono()
const nowIso = () => new Date().toISOString()

// CSL：按角色名取皮肤和披风的 hash
app.get('/csl/:name', async (c) => {
  const row = await db
    .selectFrom('players as p')
    .leftJoin('textures as s', 's.tid', 'p.tid_skin')
    .leftJoin('textures as k', 'k.tid', 'p.tid_cape')
    .select(['p.name', 's.hash as skin', 's.type as model', 'k.hash as cape'])
    .where('p.name', '=', c.req.param('name'))
    .executeTakeFirst()
  return row ? c.json(row) : c.body(null, 404)
})

// Yggdrasil hasJoined：两次查询
app.get('/ygg/hasJoined', async (c) => {
  const s = await db
    .selectFrom('ygg_sessions as y')
    .innerJoin('players as p', 'p.pid', 'y.pid')
    .select(['p.pid', 'p.uuid', 'p.name', 'p.tid_skin', 'p.tid_cape'])
    .where('y.server_id', '=', c.req.query('serverId')!)
    .where('p.name', '=', c.req.query('username')!)
    .executeTakeFirst()
  if (!s) return c.body(null, 204)
  const textures = await db
    .selectFrom('textures')
    .select(['tid', 'hash', 'type'])
    .where('tid', 'in', [s.tid_skin ?? 0, s.tid_cape ?? 0])
    .execute()
  return c.json({ id: s.uuid, name: s.name, textures })
})

// Yggdrasil join：自动提交的单条写入
app.post('/ygg/join', async (c) => {
  const { serverId, pid } = await c.req.json<{ serverId: string; pid: number }>()
  await db
    .insertInto('ygg_sessions')
    .values({ server_id: serverId, pid, access_token: 'x'.repeat(32), ip: '127.0.0.1', created_at: nowIso() })
    .onConflict((oc) => oc.column('server_id').doUpdateSet({ pid, created_at: nowIso() }))
    .execute()
  return c.body(null, 204)
})

// 衣柜分页：列表 + 总数（两条读查询并发发出）
app.get('/closet/:uid', async (c) => {
  const uid = Number(c.req.param('uid'))
  const page = Number(c.req.query('page') ?? 1)
  const [items, total] = await Promise.all([
    db
      .selectFrom('closet as c')
      .innerJoin('textures as t', 't.tid', 'c.tid')
      .select(['t.tid', 't.name', 't.type', 't.hash', 'c.item_name'])
      .where('c.uid', '=', uid)
      .orderBy('t.tid', 'desc')
      .limit(20)
      .offset((page - 1) * 20)
      .execute(),
    db.selectFrom('closet').select((eb) => eb.fn.countAll<number>().as('n')).where('uid', '=', uid).executeTakeFirstOrThrow(),
  ])
  return c.json({ items, total: Number(total.n) })
})

// 点赞：事务内 3 条语句，计数原子更新
app.post('/like/:tid', async (c) => {
  const tid = Number(c.req.param('tid'))
  const { uid } = await c.req.json<{ uid: number }>()
  const added = await db.transaction().execute(async (trx) => {
    const r = await trx.insertInto('likes').values({ uid, tid }).onConflict((oc) => oc.doNothing()).executeTakeFirst()
    if (Number(r.numInsertedOrUpdatedRows ?? 0) === 0) return false
    const t = await trx.updateTable('textures').set({ likes: sql`likes + 1` }).where('tid', '=', tid).returning('uploader').executeTakeFirst()
    if (t) await trx.updateTable('users').set({ score: sql`score + 1` }).where('uid', '=', t.uploader).execute()
    return true
  })
  return c.json({ added })
})

// 统计：事件循环延迟、干扰任务完成次数
const eld = monitorEventLoopDelay({ resolution: 5 })
eld.enable()
const counters = { slowDone: 0, slowMsTotal: 0, txDone: 0, txErrors: 0 }
app.post('/stats/reset', (c) => {
  eld.reset()
  Object.assign(counters, { slowDone: 0, slowMsTotal: 0, txDone: 0, txErrors: 0 })
  return c.body(null, 204)
})
app.get('/stats', (c) =>
  c.json({
    eventLoopDelayMs: { p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 },
    ...counters,
  }),
)

// 插件干扰：慢查询（主线程或 worker 上执行）或长时间持有的事务
let stopping = false
async function interfere() {
  if (INTERFERE === 'slow') {
    while (!stopping) {
      const t0 = performance.now()
      // 关闭时 worker 被终止，进行中的查询会被拒绝；吞掉这一次即可
      await pluginDb
        .selectFrom('p_demo__records as a')
        .innerJoin('p_demo__records as b', (j) => j.onRef('a.v', '<', 'b.v'))
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('a.id', '<=', SLOW_N)
        .where('b.id', '<=', SLOW_N)
        .executeTakeFirst()
        .catch(() => {})
      counters.slowDone++
      counters.slowMsTotal += performance.now() - t0
      await sleep(100)
    }
  } else if (INTERFERE === 'tx') {
    while (!stopping) {
      try {
        await pluginDb.transaction().execute(async (trx) => {
          await trx.updateTable('p_demo__records').set({ v: sql`v + 1` }).where('id', '=', 1 + Math.floor(Math.random() * 1000)).execute()
          // 模拟拦截器里的一次 RPC 往返：事务开着，但没有在执行 SQL
          await sleep(TX_HOLD_MS)
        })
        counters.txDone++
      } catch {
        counters.txErrors++
      }
      await sleep(50)
    }
  }
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  console.log(`ready mode=${MODE} interfere=${INTERFERE} port=${PORT}`)
  void interfere()
})

process.on('SIGTERM', async () => {
  stopping = true
  server.close()
  await db.destroy().catch(() => {})
  if (pluginDb !== db) await pluginDb.destroy().catch(() => {})
  process.exit(0)
})
