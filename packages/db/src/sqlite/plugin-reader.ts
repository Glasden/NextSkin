import { Worker } from 'node:worker_threads'

export interface PluginReadRequest {
  pluginId: string
  sql: string
  parameters: readonly unknown[]
  deadline: number
}
export class PluginReadError extends Error {
  readonly code: 'timeout' | 'rejected' | 'failed'
  constructor(code: 'timeout' | 'rejected' | 'failed', reason?: string) {
    super(reason ?? `Plugin read ${code}`)
    this.code = code
  }
}
interface Reply {
  reason?: string
  rows?: Record<string, unknown>[]
  code?: 'timeout' | 'rejected' | 'failed'
}
interface Pending {
  request: PluginReadRequest
  resolve(result: { rows: Record<string, unknown>[] }): void
  reject(error: Error): void
}

/** 一个插件专用读连接；同步 SQLite 卡住时丢弃 worker，不等待 terminate 完成。 */
export function createPluginSqliteReader(file: string) {
  let worker: Worker | undefined
  let pending: Pending | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const queue: Pending[] = []
  const abandoned = new Set<Worker>()

  function retire() {
    const old = worker
    worker = undefined
    if (!old) return
    abandoned.add(old)
    // 原生查询可能还在执行。名额只在 exit 时释放，不以 terminate 的调用时刻为准。
    old.once('exit', () => abandoned.delete(old))
    void old.terminate().catch(() => {})
  }
  function finish(reply: Reply) {
    clearTimeout(timer)
    const task = pending
    pending = undefined
    if (reply.code) task?.reject(new PluginReadError(reply.code, reply.reason))
    else task?.resolve({ rows: reply.rows! })
    worker?.unref()
  }
  function drain() {
    if (closed || pending) return
    while (queue.length) {
      const task = queue.shift()!
      if (abandoned.size >= 2 || Date.now() >= task.request.deadline) {
        task.reject(new PluginReadError('timeout'))
        continue
      }
      pending = task
      try {
        if (!worker) {
          const current = new Worker(new URL('./plugin-read-worker.ts', import.meta.url), { workerData: { file } })
          worker = current
          current.on('message', (reply: Reply) => {
            if (worker !== current) return
            finish(reply)
            drain()
          })
          const fail = () => {
            if (worker !== current) return
            finish({ code: 'failed' })
            retire()
            drain()
          }
          current.on('error', fail)
          current.on('exit', fail)
        }
        const current = worker
        current.ref()
        timer = setTimeout(
          () => {
            if (worker !== current) return
            finish({ code: 'timeout' })
            retire()
            drain()
          },
          Math.max(1, task.request.deadline - Date.now() + 50),
        )
        current.postMessage(task.request)
      } catch {
        finish({ code: 'failed' })
        retire()
        drain()
      }
      return
    }
  }
  return {
    execute(request: PluginReadRequest): Promise<{ rows: Record<string, unknown>[] }> {
      if (closed) return Promise.reject(new PluginReadError('failed'))
      if (abandoned.size >= 2) return Promise.reject(new PluginReadError('timeout'))
      if (queue.length >= 64) return Promise.reject(new PluginReadError('rejected', 'too many queued plugin reads'))
      return new Promise((resolve, reject) => {
        queue.push({ request, resolve, reject })
        drain()
      })
    },
    close(): Promise<void> {
      closed = true
      for (const task of queue.splice(0)) task.reject(new PluginReadError('failed'))
      finish({ code: 'failed' })
      retire()
      return Promise.resolve()
    },
  }
}
