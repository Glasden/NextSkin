/**
 * 插件 host 进程（子进程）。由核心以 `node --permission` 启动，环境变量为空。
 * 只能使用可擦除的 TS 语法：这里依赖 Node 原生类型剥离运行，不经过 tsx。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Kysely } from 'kysely'
import { type CoreDialect, type DbRequest, remoteDialect } from './remote-dialect.ts'
import * as plugin from './test-plugin.ts'

const invocation = new AsyncLocalStorage<{ invocationId: string }>()
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
let sequence = 0

function rpc(request: DbRequest): Promise<any> {
  const id = ++sequence
  const invocationId = invocation.getStore()?.invocationId
  process.send!({ type: 'db', id, request, invocationId })
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

const db = new Kysely<plugin.DB>({ dialect: remoteDialect(process.argv[2] as CoreDialect, rpc) })

process.on('message', (message: any) => {
  if (message.type === 'dbResult') {
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.ok) waiter?.resolve(message.value)
    else waiter?.reject(new Error(message.error))
    return
  }
  if (message.type === 'call') {
    invocation.run({ invocationId: message.invocationId }, async () => {
      try {
        const op = (plugin.ops as Record<string, plugin.Op>)[message.op]
        if (!op) throw new Error(`unknown op ${message.op}`)
        const value = await op(db, message.args, rpc)
        process.send!({ type: 'result', id: message.id, ok: true, value })
      } catch (error) {
        process.send!({ type: 'result', id: message.id, ok: false, error: (error as Error).message })
      }
    })
  }
})

process.send!({ type: 'ready' })
