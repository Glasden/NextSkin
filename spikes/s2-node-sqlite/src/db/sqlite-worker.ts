/**
 * worker 线程里的 SQLite 连接。一个 worker 一个连接，按消息顺序串行执行。
 * 角色由 workerData 决定：writer 可写；reader 以只读方式打开；plugin 额外装上 authorizer，只允许访问指定前缀的表。
 */
import { DatabaseSync, constants } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { CORE_PRAGMAS, normalizeParams } from './node-sqlite.ts'

export interface WorkerInit {
  file: string
  role: 'writer' | 'reader' | 'plugin'
  /** role = plugin 时：允许访问的物理表名前缀，例如 `p_demo__` */
  tablePrefix?: string
  busyTimeoutMs: number
}
export interface WorkerRequest {
  id: number
  sql: string
  params: ReadonlyArray<unknown>
}
export type WorkerResponse =
  | { id: number; ok: true; rows: unknown[]; changes?: number | bigint; lastInsertRowid?: number | bigint }
  | { id: number; ok: false; message: string; code?: string; errcode?: number }

const init = workerData as WorkerInit
const db = new DatabaseSync(init.file, { readOnly: init.role !== 'writer', timeout: init.busyTimeoutMs })
for (const p of CORE_PRAGMAS) {
  // 只读连接不能改 journal_mode，跳过即可：WAL 是数据库文件级别的设置
  if (init.role !== 'writer' && p.includes('journal_mode')) continue
  db.exec(p)
}
if (init.role === 'plugin') {
  const C = constants as Record<string, number>
  const prefix = init.tablePrefix!
  db.setAuthorizer((action, a1) => {
    switch (action) {
      case C.SQLITE_READ:
        return a1 !== null && a1.startsWith(prefix) ? C.SQLITE_OK : C.SQLITE_DENY
      case C.SQLITE_SELECT:
      case C.SQLITE_FUNCTION:
        return C.SQLITE_OK
      default:
        return C.SQLITE_DENY
    }
  })
}

const NO_NAMED = Object.freeze({})
const cache = new Map<string, { stmt: ReturnType<DatabaseSync['prepare']>; reader: boolean }>()

parentPort!.on('message', (req: WorkerRequest) => {
  let res: WorkerResponse
  try {
    let c = cache.get(req.sql)
    if (!c) {
      const stmt = db.prepare(req.sql)
      c = { stmt, reader: stmt.columns().length > 0 }
      cache.set(req.sql, c)
      if (cache.size > 256) cache.delete(cache.keys().next().value!)
    }
    const params = normalizeParams(req.params) as any[]
    if (c.reader) {
      res = { id: req.id, ok: true, rows: c.stmt.all(NO_NAMED, ...params) }
    } else {
      const r = c.stmt.run(NO_NAMED, ...params)
      res = { id: req.id, ok: true, rows: [], changes: r.changes, lastInsertRowid: r.lastInsertRowid }
    }
  } catch (e: any) {
    res = { id: req.id, ok: false, message: String(e?.message ?? e), code: e?.code, errcode: e?.errcode }
  }
  parentPort!.postMessage(res)
})
