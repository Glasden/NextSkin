/**
 * 核心这边的 plugin host（ADR-0009、ADR-0033）：拉起 host 进程、比对 manifest、转发调用和插件发回的请求。
 *
 * 一个 host 进程就是一代（HostGeneration）。什么时候换代、崩溃后要不要重启，由 system.ts 决定。
 * host 不可信：它发来的每条消息都检查形状，违反协议就杀掉它；插件的请求只认这一代自己收到过的 invocation。
 */
import { spawn } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { discardLogger, lineSplitter, type Logger } from '@nextskin/logging'
import {
  ChannelClosedError,
  createFrameChannel,
  FrameTooLargeError,
  type CoreDialect,
  type CoreToHost,
  type HostPluginSpec,
  type HostToCore,
  type InvocationContext,
  type PluginCall,
  type PluginContributions,
  type WireError,
} from '@nextskin/plugin-host'
import type { PluginManifest } from '@nextskin/plugin-sdk'

export interface PluginHostEntry {
  /** host 的入口：开发和测试时是 plugin-host 的源码 `src/host/main.ts`，standalone 产物里是打好包的 `dist/host.mjs` */
  readonly script: string
  /** host 进程能读的路径：入口和它的依赖。插件目录按这一代的组合另外加 */
  readonly readPaths: readonly string[]
}

export interface HostedPlugin extends HostPluginSpec {
  readonly manifest: PluginManifest
  /** 插件包的 sha256：同一个版本号换了内容也是另一个插件 */
  readonly hash: string
}

/** 拉起新一代失败：进程起不来、插件加载失败、实际的定义和 manifest 对不上、超时 */
export class HostStartError extends Error {
  override name = 'HostStartError'
  readonly pluginId: string | null
  constructor(message: string, pluginId: string | null = null) {
    super([...message].slice(0, 500).join(''))
    this.pluginId = pluginId
  }
}

/**
 * Node 25 起，`--permission` 不给 `--allow-net` 就不能连网；Node 24 的权限模型拦不住网络，
 * 插件绕过 `ctx.fetch` 自己连网时只能如实告诉管理员（ADR-0033"网络"）
 */
export const hostNetworkRestricted = process.allowedNodeEnvironmentFlags.has('--allow-net')

/** 环境自检只起一个空的 host，完成同样的权限模型和帧协议握手后立即退出。 */
export async function probePluginHost(
  entry: PluginHostEntry,
  options: { readyTimeoutMs?: number } = {},
): Promise<void> {
  const generation = await startHostGeneration({
    entry,
    dialect: 'sqlite',
    fallbackLocale: 'zh-CN',
    plugins: [],
    sequence: 0,
    onRequest: () => Promise.reject(new Error('空的 plugin host 不应请求核心')),
    onExit: () => {},
    logger: discardLogger,
    readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
  })
  await generation.kill()
}

const READY_TIMEOUT_MS = 30_000
/** 让一代退出时，关掉 stdin 之后最多等这么久，然后强杀 */
const EXIT_GRACE_MS = 5_000
/** 退役的一代最多等在途调用这么久：插件任务的超时上限是 10 分钟 */
const RETIRE_LIMIT_MS = 11 * 60_000
const MAX_STDERR_LINE = 2000

export interface HostGeneration {
  readonly sequence: number
  /** 这一代的插件组合，`id@版本` 排序后拼起来 */
  readonly key: string
  readonly plugins: ReadonlyMap<string, HostedPlugin>
  readonly alive: boolean
  /** 这个 invocation 是不是交给这一代、还在等结果的调用 */
  owns(invocationId: string): boolean
  call(pluginId: string, call: PluginCall, context: InvocationContext): Promise<unknown>
  /** 核心不再等这次调用了：让插件的 `ctx.signal` 中止 */
  cancel(invocationId: string): void
  /** 不再接新调用；在途的调用结束后让进程退出 */
  retire(): Promise<void>
  /** 立即结束进程，在途的调用按不可用处理 */
  kill(): Promise<void>
}

export function generationKey(plugins: readonly { id: string; version: string; hash: string }[]): string {
  return plugins
    .map((plugin) => `${plugin.id}@${plugin.version}#${plugin.hash}`)
    .sort()
    .join(',')
}

/** 调用没有送到插件：host 不可用、已经退出、通道关了。由核心这边判断，插件抛出的错误不会是这个类 */
export class PluginHostUnavailableError extends Error {
  override name = 'PluginHostUnavailableError'
}

export function unavailableError(message = 'plugin host 不可用'): Error {
  return new PluginHostUnavailableError(message)
}

/** manifest 里由插件定义决定的部分：新一代报告的实际定义要和它完全相同 */
function contributionsOf(manifest: PluginManifest): PluginContributions {
  const { manifestVersion, id, version, api, requires, conflicts, entry, integrity, ...contributions } = manifest
  void [manifestVersion, id, version, api, requires, conflicts, entry, integrity]
  return contributions
}

/** 对不上的顶层字段：报给管理员，说明插件包的 manifest 和代码不是同一次构建出来的 */
function mismatch(actual: unknown, manifest: PluginManifest): string | null {
  const expected = JSON.parse(JSON.stringify(contributionsOf(manifest))) as Record<string, unknown>
  let reported: Record<string, unknown>
  try {
    reported = JSON.parse(JSON.stringify(actual)) as Record<string, unknown>
  } catch {
    return '(无法读取)'
  }
  if (!reported || typeof reported !== 'object') return '(无法读取)'
  for (const key of new Set([...Object.keys(expected), ...Object.keys(reported)]))
    if (!isDeepStrictEqual(expected[key], reported[key])) return key
  return null
}

function wireError(error: unknown): WireError {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: [...(error instanceof Error ? error.message : String(error))].slice(0, 500).join(''),
    ...(typeof code === 'string' ? { code } : {}),
  }
}

function fromWire(error: unknown): Error {
  const e = (error && typeof error === 'object' ? error : {}) as Partial<WireError>
  return Object.assign(new Error(typeof e.message === 'string' ? e.message : 'plugin host 返回了无效的错误'), {
    name: typeof e.name === 'string' ? e.name : 'Error',
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function startHostGeneration(options: {
  entry: PluginHostEntry
  dialect: CoreDialect
  fallbackLocale: string
  plugins: readonly HostedPlugin[]
  sequence: number
  /** 插件在一次调用里发回的请求；这一代没收到过的 invocation 在这之前就被拒绝了 */
  onRequest(invocationId: string, method: string, args: unknown): Promise<unknown>
  /** 就绪之后进程意外退出（不是 retire、kill 让它退出的） */
  onExit(generation: HostGeneration, detail: string): void
  logger: Logger
  readyTimeoutMs?: number
}): Promise<HostGeneration> {
  const { entry, sequence, logger } = options
  const plugins = new Map(options.plugins.map((plugin) => [plugin.id, plugin]))
  const readable = [...entry.readPaths, ...options.plugins.map((plugin) => plugin.dir)]
  const child = spawn(
    process.execPath,
    ['--permission', ...readable.map((path) => `--allow-fs-read=${path}`), entry.script],
    // 环境变量为空：读不到 .env 里的密钥和数据库地址（ADR-0009）
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Next 的类型给 ProcessEnv 加了必填的 NODE_ENV，apps/web 类型检查时要这个断言
      env: {} as NodeJS.ProcessEnv,
      windowsHide: true,
    },
  )
  const log = logger.child({ area: 'plugin-host', generation: sequence })
  const stderr = logger.child({ source: 'plugin-host', generation: sequence })
  // stderr 按行记日志，一行最多 MAX_STDERR_LINE 个字符（lineSplitter 不在内存里攒）
  const stderrLines = lineSplitter(MAX_STDERR_LINE, (line) => stderr.warn(line))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderrLines.push(chunk))
  child.stderr.on('end', () => stderrLines.end())

  const pending = new Map<number, { invocationId: string; resolve(value: unknown): void; reject(error: Error): void }>()
  const byInvocation = new Map<string, number>()
  let callSequence = 0
  let ready = false
  let alive = true
  let retiring = false
  /** retire 或 kill 让它退出的，不算意外退出 */
  let stopping = false
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

  function settle(id: number) {
    const entry = pending.get(id)
    if (!entry) return undefined
    pending.delete(id)
    byInvocation.delete(entry.invocationId)
    if (retiring && !pending.size) finish()
    return entry
  }

  function finish() {
    if (channel.closed) return
    channel.end()
    setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS).unref()
  }

  function fail(reason: string) {
    log.warn('protocol_error', { reason })
    child.kill('SIGKILL')
  }

  let resolveReady!: (generation: HostGeneration) => void
  let rejectReady!: (error: Error) => void
  const started = new Promise<HostGeneration>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const readyTimer = setTimeout(() => {
    rejectReady(new HostStartError(`plugin host 在 ${options.readyTimeoutMs ?? READY_TIMEOUT_MS} ms 内没有加载完插件`))
    stopping = true
    child.kill('SIGKILL')
  }, options.readyTimeoutMs ?? READY_TIMEOUT_MS)

  function onReady(message: Record<string, unknown>) {
    clearTimeout(readyTimer)
    const results = message.plugins
    if (!Array.isArray(results) || results.length !== plugins.size) return fail('ready')
    const seen = new Set<string>()
    for (const result of results) {
      if (!isRecord(result) || typeof result.id !== 'string' || !plugins.has(result.id) || seen.has(result.id))
        return fail('ready')
      seen.add(result.id)
      if (result.ok !== true) {
        stopping = true
        child.kill('SIGKILL')
        return rejectReady(
          new HostStartError(
            `插件 ${result.id} 加载失败：${typeof result.error === 'string' ? result.error : '未知错误'}`,
            result.id,
          ),
        )
      }
      const field = mismatch(result.contributions, plugins.get(result.id)!.manifest)
      if (field !== null) {
        stopping = true
        child.kill('SIGKILL')
        return rejectReady(
          new HostStartError(`插件 ${result.id} 实际的定义和 manifest 对不上（${field}）；请重新构建插件包`, result.id),
        )
      }
    }
    ready = true
    resolveReady(generation)
  }

  function onRpc(message: Record<string, unknown>) {
    const { id, invocationId, method, args } = message
    if (!isId(id) || typeof invocationId !== 'string' || typeof method !== 'string') return fail('rpc')
    // 在 Promise 的回调里执行，抛出去就成了核心进程里没人处理的拒绝：发不出去时只能放弃，通道关了 host 也会被杀掉
    const reply = (result: { ok: true; value: unknown } | { ok: false; error: WireError }) => {
      if (channel.closed) return
      try {
        channel.send({ type: 'rpcResult', id, ...result })
      } catch (error) {
        if (!(error instanceof FrameTooLargeError) || channel.closed) return
        try {
          channel.send({ type: 'rpcResult', id, ok: false, error: wireError(error) })
        } catch {
          // 同上
        }
      }
    }
    if (!byInvocation.has(invocationId)) {
      reply({
        ok: false,
        error: { name: 'PluginCallRejected', message: '这次调用已经结束，不能再访问核心' },
      })
      return
    }
    options.onRequest(invocationId, method, args).then(
      (value) => reply({ ok: true, value }),
      (error: unknown) => reply({ ok: false, error: wireError(error) }),
    )
  }

  const channel = createFrameChannel<HostToCore, CoreToHost>({
    input: child.stdout,
    output: child.stdin,
    onMessage(message) {
      if (!isRecord(message)) return fail('message')
      // type 由对面决定，可能是任意值（转字符串也可能抛）：只在日志里记字符串
      const type = typeof message.type === 'string' ? [...message.type].slice(0, 50).join('') : 'message'
      if (!ready) return message.type === 'ready' ? onReady(message) : fail(type)
      switch (message.type) {
        case 'result': {
          if (!isId(message.id)) return fail('result')
          const entry = settle(message.id)
          if (!entry) return
          if (message.ok === true) entry.resolve(message.value)
          else entry.reject(fromWire(message.error))
          return
        }
        case 'rpc':
          return onRpc(message)
        default:
          return fail(type)
      }
    },
    onClose(error) {
      // 通道关了进程也就没用了：超长的消息、解不开的消息都走到这里
      if (error) log.warn('channel_closed', { reason: error.message })
      child.kill('SIGKILL')
    },
  })

  child.once('exit', (code, signal) => {
    const wasAlive = alive
    alive = false
    clearTimeout(readyTimer)
    for (const id of [...pending.keys()]) settle(id)?.reject(unavailableError('plugin host 已经退出'))
    const detail = `code=${code ?? ''} signal=${signal ?? ''}`
    if (!ready) {
      rejectReady(new HostStartError(`plugin host 启动失败（${detail}）`))
      return
    }
    if (wasAlive && !stopping) {
      log.warn('exited', { code, signal })
      options.onExit(generation, detail)
    }
  })
  child.once('error', (error) => {
    log.error('spawn_failed', { error: error.name })
    rejectReady(new HostStartError('plugin host 启动失败'))
  })

  const generation: HostGeneration = {
    sequence,
    key: generationKey(options.plugins),
    plugins,
    get alive() {
      return alive && !retiring
    },
    owns: (invocationId) => byInvocation.has(invocationId),
    call(pluginId, call, context) {
      if (!alive || retiring || !plugins.has(pluginId)) return Promise.reject(unavailableError())
      return new Promise((resolve, reject) => {
        const id = ++callSequence
        pending.set(id, { invocationId: context.invocationId, resolve, reject })
        byInvocation.set(context.invocationId, id)
        try {
          channel.send({ type: 'call', id, pluginId, call, context })
        } catch (error) {
          settle(id)
          // 通道已经关了（host 正在退出、积压太多被关掉）：调用没送到插件，按 host 不可用处理，任务会放回队列。
          // 消息太大、序列化不了是这次调用本身的问题，重试也一样
          reject(
            error instanceof ChannelClosedError
              ? unavailableError()
              : error instanceof Error
                ? error
                : new Error(String(error)),
          )
        }
      })
    },
    cancel(invocationId) {
      const id = byInvocation.get(invocationId)
      if (id === undefined) return
      try {
        if (!channel.closed) channel.send({ type: 'cancel', invocationId })
      } catch {
        // 通道已经因为积压关掉了：host 随后被杀掉，插件那边的调用也就停了
      }
      // 先通知取消，再结算最后一个调用；退役的一代可能随结算关闭 stdin。
      settle(id)?.reject(Object.assign(new Error('plugin call cancelled'), { name: 'PluginTimeoutError' }))
    },
    async retire() {
      if (!retiring) {
        retiring = true
        stopping = true
        if (!pending.size) finish()
        else
          setTimeout(() => {
            log.warn('retire_timeout')
            child.kill('SIGKILL')
          }, RETIRE_LIMIT_MS).unref()
      }
      await exited
    },
    async kill() {
      stopping = true
      alive = false
      child.kill('SIGKILL')
      await exited
    },
  }

  try {
    channel.send({
      type: 'init',
      dialect: options.dialect,
      fallbackLocale: options.fallbackLocale,
      plugins: options.plugins.map(({ id, version, dir, entry: file, messages }) => ({
        id,
        version,
        dir,
        entry: file,
        messages,
      })),
    })
  } catch (error) {
    // 例如这一代所有插件的文案加起来超过了单条消息的上限：这一代起不来，交给调用方按启动失败处理
    clearTimeout(readyTimer)
    stopping = true
    child.kill('SIGKILL')
    rejectReady(
      new HostStartError(
        error instanceof FrameTooLargeError ? '这一代插件的文案加起来太大，plugin host 收不下' : 'plugin host 启动失败',
      ),
    )
  }
  return started
}
