import { DatabaseSync, constants } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { serialize } from 'node:v8'
import { PLUGIN_DEADLINE_ERROR, registerPluginDeadline } from './deadline.ts'
import { normalizeParams } from './node-sqlite.ts'
import type { PluginReadRequest } from './plugin-reader.ts'

const { file } = workerData as { file: string }
const db = new DatabaseSync(file, { readOnly: true })
registerPluginDeadline(db)
let prefix = ''
db.setAuthorizer((action, table) => {
  if (action === constants.SQLITE_READ)
    return table?.startsWith(prefix) && prefix ? constants.SQLITE_OK : constants.SQLITE_DENY
  if (action === constants.SQLITE_SELECT || action === constants.SQLITE_FUNCTION) return constants.SQLITE_OK
  return constants.SQLITE_DENY
})
parentPort!.on('message', (request: PluginReadRequest) => {
  prefix = `p_${request.pluginId.replaceAll('-', '_')}__`
  try {
    if (Date.now() >= request.deadline) throw new Error(PLUGIN_DEADLINE_ERROR)
    // 不缓存 statement：authorizer 在 prepare 时检查，不能把上个插件的授权沿用到下一次调用。
    const statement = db.prepare(request.sql)
    const rows = []
    let bytes = 0
    for (const row of statement.iterate({}, ...normalizeParams(request.parameters))) {
      if (rows.length === 10_000) {
        parentPort!.postMessage({ code: 'rejected', reason: 'result exceeds 10000 rows' })
        return
      }
      const plain = { ...row }
      bytes += serialize(plain).byteLength
      if (bytes > 8 * 1024 * 1024) {
        parentPort!.postMessage({ code: 'rejected', reason: 'result message exceeds 8 MiB' })
        return
      }
      rows.push(plain)
    }
    if (serialize(rows).byteLength > 8 * 1024 * 1024)
      parentPort!.postMessage({ code: 'rejected', reason: 'result message exceeds 8 MiB' })
    else parentPort!.postMessage({ rows })
  } catch (error) {
    parentPort!.postMessage({
      code: error instanceof Error && error.message === PLUGIN_DEADLINE_ERROR ? 'timeout' : 'failed',
    })
  } finally {
    prefix = ''
  }
})
