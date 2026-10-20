/**
 * plugin host 进程的入口（ADR-0009、ADR-0033）。
 *
 * 核心以 `node --permission` 拉起它：只能读自己的代码和这一代插件的目录，环境变量为空，
 * Node 26 起不给 `--allow-net` 也不能直接连网（插件的出站请求走 `ctx.fetch`，由核心代发）。
 * stdin/stdout 是和核心之间的通道（channel.ts），插件的输出都改到 stderr。
 * stdin 一结束就退出：核心退出、或者让这一代退出时都是这样，不会留下孤儿进程。
 *
 * 一个进程就是一代：收到一次 `init`，加载这一代的插件，报告各插件实际的定义；核心和 manifest 比对通过才切换过来。
 *
 * 开发和测试时由 Node 直接运行这个源文件；standalone 产物里用打好包的 `dist/host.mjs`（scripts/build-host.ts）。
 * 只能用可擦除的 TS 语法，相对导入写 `.ts`。
 */
import { Console } from 'node:console'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import * as sdk from '@nextskin/plugin-sdk'
import * as zod from 'zod'
import { createFrameChannel, FrameTooLargeError } from '../channel.ts'
import { describePlugin, type AnyPluginDefinition } from '../manifest.ts'
import { importPluginDefinition, installPluginModuleHooks } from '../package/module-loader.ts'
import type { CoreRpc, CoreToHost, HostLoadResult, HostPluginSpec, HostToCore, WireError } from '../protocol.ts'
import { loadPlugin, type LoadedPlugin } from '../runtime.ts'

// Windows 的 libuv 即使收到 env: {} 也会补 PATH、SYSTEMROOT 等变量；加载任何插件前再清空。
// Windows 上 SYSTEMROOT（系统目录，不是机密）留着：没有它 OpenSSL 取不到熵，crypto.getRandomValues 会抛错
for (const key of Object.keys(process.env))
  if (process.platform !== 'win32' || key.toUpperCase() !== 'SYSTEMROOT') delete process.env[key]

const input = process.stdin
const output = process.stdout
// stdout 上只能有通道的消息：插件的 console 和 process.stdout 都改到 stderr，process.stdin 换成空流
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
Object.defineProperty(process, 'stdout', { value: process.stderr, configurable: true, enumerable: true })
Object.defineProperty(process, 'stdin', { value: Readable.from([]), configurable: true, enumerable: true })

// 终端的 Ctrl+C 会发给整个进程组，宝塔停止项目、systemd 默认的 KillMode 会给整棵进程树发 SIGTERM：
// host 等核心收完任务、关掉 stdin 再退出，不抢在核心前面。核心要强行结束它时发 SIGKILL
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
// 插件忘了 await 的 Promise 失败了不该带走同一个 host 里的其他插件
process.on('unhandledRejection', (reason) => console.error(`[plugin-host] unhandled_rejection ${describe(reason)}`))
process.on('uncaughtException', (error) => {
  console.error(`[plugin-host] uncaught_exception ${describe(error)}`)
  process.exit(1)
})

installPluginModuleHooks({ '@nextskin/plugin-sdk': sdk, zod })

const plugins = new Map<string, LoadedPlugin>()
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
let sequence = 0
let initialized = false

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return [...text].slice(0, 500).join('')
}

function toWire(error: unknown): WireError {
  const name = error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return {
    name: [...String(name)].slice(0, 100).join(''),
    message: [...String(message)].slice(0, 500).join(''),
    ...(typeof code === 'string' ? { code: code.slice(0, 100) } : {}),
  }
}

const channel = createFrameChannel<CoreToHost, HostToCore>({
  input,
  output,
  onMessage: (message) => void handle(message),
  onClose: () => process.exit(0),
})

function send(message: HostToCore) {
  if (channel.closed) return
  try {
    channel.send(message)
  } catch (error) {
    // 插件的返回值太大：这次调用按失败处理，host 照常运行
    if (error instanceof FrameTooLargeError && message.type === 'result')
      channel.send({ type: 'result', id: message.id, ok: false, error: toWire(error) })
    else throw error
  }
}

const rpc = ((invocationId: string, method: string, args: unknown) =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    try {
      channel.send({ type: 'rpc', id, invocationId, method: method as never, args })
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })) as CoreRpc

async function load(spec: HostPluginSpec, init: Extract<CoreToHost, { type: 'init' }>): Promise<HostLoadResult> {
  try {
    const definition = (await importPluginDefinition(join(spec.dir, spec.entry))) as AnyPluginDefinition
    const contributions = describePlugin(definition)
    plugins.set(
      spec.id,
      loadPlugin({
        id: spec.id,
        version: spec.version,
        definition,
        messages: spec.messages,
        dialect: init.dialect,
        fallbackLocale: init.fallbackLocale,
        rpc,
      }),
    )
    return { id: spec.id, ok: true, contributions }
  } catch (error) {
    return { id: spec.id, ok: false, error: describe(error) }
  }
}

async function handle(message: CoreToHost): Promise<void> {
  switch (message.type) {
    case 'init': {
      if (initialized) return
      initialized = true
      const results: HostLoadResult[] = []
      for (const spec of message.plugins) results.push(await load(spec, message))
      send({ type: 'ready', plugins: results })
      return
    }
    case 'call': {
      try {
        const plugin = plugins.get(message.pluginId)
        if (!plugin) throw new Error(`这一代 host 没有加载插件 ${message.pluginId}`)
        const value = await plugin.invoke(message.call, message.context)
        send({ type: 'result', id: message.id, ok: true, value })
      } catch (error) {
        send({ type: 'result', id: message.id, ok: false, error: toWire(error) })
      }
      return
    }
    case 'cancel':
      for (const plugin of plugins.values()) plugin.cancel(message.invocationId)
      return
    case 'rpcResult': {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.ok) waiter.resolve(message.value)
      else
        waiter.reject(
          Object.assign(new Error(message.error.message), {
            name: message.error.name,
            ...(message.error.code !== undefined ? { code: message.error.code } : {}),
          }),
        )
      return
    }
  }
}
