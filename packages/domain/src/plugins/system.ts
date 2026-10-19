/**
 * 核心侧的插件运行时（ADR-0033）。
 *
 * - 每次调用插件都登记一个 invocation：插件在这次调用里发回的请求都带着它的 id，
 *   能不能执行 DDL、是不是加入核心事务、还剩多少时间，只由核心登记的 invocation 决定，不信任插件。
 * - 按 manifest 登记事件、任务、定时任务、拦截器和路由；按 `plugins` 表里授予的能力放行请求。
 * - 官方插件在核心进程内运行，同样经过这里的检查和超时；参数和返回值克隆一次，
 *   和跨进程时一样，在进程内就能发现不可序列化的数据。
 * - 安装插件在 plugin host 进程里运行（host.ts）。插件的组合变了就整代切换：先拉起新一代、比对 manifest，
 *   通过了才把新的调用交给它，旧的一代处理完在途的调用后退出（ADR-0009）。
 * - 每个实例每 5 秒读一次 `plugins` 表里的启用集合，和当前不一致就自己切换（多实例部署）。
 *   插件按表里的启用状态登记，和 host 是否可用无关：host 不可用时拦截器照样按失败策略拒绝，
 *   插件的任务和事件留在表里，等 host 恢复（ADR-0033"运行时防护"）。
 */
import { randomUUID } from 'node:crypto'
import { ExclusiveLockBusyError, withExclusiveLock, type CoreDatabase, type IsoTimestamp } from '@nextskin/db'
import {
  buildManifest,
  loadPlugin,
  translatePlugin,
  type AnyPluginDefinition,
  type CoreDialect,
  type CoreMethod,
  type CoreRequests,
  type InterceptOutcome,
  type LoadedPlugin,
  type PluginCall,
  type PluginMessages,
  type PluginPackageJson,
  type SerializedRequest,
  type SerializedResponse,
} from '@nextskin/plugin-host'
import {
  interceptorPolicies,
  type Capability,
  type CoreInterceptors,
  type ExtraFields,
  type Field,
  type Json,
  type PluginManifest,
  type RequestScope,
  type UserRole,
} from '@nextskin/plugin-sdk'
import type { Kysely } from 'kysely'
import { canPlugin } from '../access/permissions.ts'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import { JobDeferredError, type JobHandler, type JobRunner } from '../jobs/runner.ts'
import type { createScheduler } from '../jobs/schedules.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import type { TextureStorage } from '../textures/storage.ts'
import { createPluginCoreData } from './core-data.ts'
import { PluginCallRejected, PluginInvocationError } from './errors.ts'
import { pluginFetch } from './fetch.ts'
import {
  generationKey,
  hostNetworkRestricted,
  HostStartError,
  startHostGeneration,
  PluginHostUnavailableError,
  unavailableError,
  type HostedPlugin,
  type HostGeneration,
  type PluginHostEntry,
} from './host.ts'
import { createPluginKv, MAX_KV_VALUE_BYTES } from './kv.ts'
import type { LocalPluginPackage, PluginPackages } from './packages.ts'
import { createPluginSettings, settingProperties, type PluginSettingProperty } from './settings.ts'

/** 随发行包分发的官方插件：`plugins/*` 里的包 */
export interface OfficialPlugin {
  definition: AnyPluginDefinition
  package: PluginPackageJson
  /** `locales/<语言>.json` */
  messages: PluginMessages
}

/** 插件自有表的网关（`plugins/db/gateway.ts`） */
export interface PluginDbExecutor {
  execute(
    scope: {
      pluginId: string
      tables: ReadonlySet<string>
      allowDdl: boolean
      transaction?: Kysely<CoreDatabase>
      timeoutMs: number
    },
    node: unknown,
  ): Promise<{ rows: Record<string, unknown>[]; numAffectedRows?: bigint; insertId?: bigint }>
  dropTables(pluginId: string, tables: readonly string[]): Promise<void>
  dropAllTables(pluginId: string): Promise<void>
  close(): Promise<void>
}

/** 插件里注册表单的一个字段，`pluginId` 区分不同插件的同名字段 */
export interface PluginFormField {
  pluginId: string
  field: Field
}

export interface PluginRouteRequest {
  pluginId: string
  method: string
  /** `/plugins/{id}` 后面的部分，以 `/` 开头 */
  path: string
  request: SerializedRequest
  user: { uid: number; role: UserRole } | null
  ip: string
  locale: string
}

/** 卸载安装插件之后删表、删插件包的任务（ADR-0033"卸载"） */
export const PLUGIN_CLEANUP_JOB = 'core:plugin-cleanup'
/**
 * 卸载之后等这么久再删表和插件包：每个实例最多 5 秒后停掉它，旧的一代还要把在途的调用做完
 * （插件任务最长 10 分钟，退役的一代最多等 11 分钟）
 */
const CLEANUP_DELAY_MS = 12 * 60_000
const cleanupKey = (id: string) => `plugin-cleanup:${id}`
/**
 * 同一个插件的启用、停用、安装、升级、卸载和卸载后的清理，在各实例之间串行：
 * 跑迁移、删存储里的插件包这些副作用回滚不了，事务里的行锁又不能跨过它们一直拿着
 */
const lockName = (id: string) => `nextskin:plugin:${id}`

interface CleanupPayload {
  id: string
  /** 卸载时插件表里的那个包：清理时它没被重新装回来就从存储里删掉 */
  hash: string
}

function parseCleanup(payload: unknown): CleanupPayload {
  const value = payload as Partial<Record<keyof CleanupPayload, unknown>>
  if (typeof value.id !== 'string' || typeof value.hash !== 'string') throw new DomainError('invalid_request')
  return { id: value.id, hash: value.hash }
}

const SYNC_INTERVAL_MS = 5_000
const EVENT_TIMEOUT_MS = 60_000
const ROUTE_TIMEOUT_MS = 30_000
const MIGRATION_TIMEOUT_MS = 60_000
const SETTINGS_TIMEOUT_MS = 5_000
/** passwordHasher 每次调用的期限，写在 SDK 的说明里（providers.ts） */
const PASSWORD_TIMEOUT_MS = 5_000
/** 比这更长的值不是哈希，不拿去匹配插件的 detect.pattern */
const MAX_PLUGIN_HASH_LENGTH = 512
/** 同一个拦截器连续失败这么多次，就在冷却期内不再调用它，直接按失败策略处理（ADR-0033） */
const BREAKER_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 30_000
const MAX_JOB_PAYLOAD_BYTES = 64 * 1024
const MAX_DELAY_SEC = 30 * 86_400
/** host 在这段时间里崩溃这么多次，就不再自动重启，在后台的插件页提示管理员（ADR-0033"运行时防护"） */
const CRASH_WINDOW_MS = 10 * 60_000
const MAX_CRASHES = 5
/** 新一代起不来（加载失败、manifest 对不上）之后，同样的组合隔多久再试 */
const START_RETRY_MS = 60_000
const START_RETRY_MAX_MS = 10 * 60_000

export interface KnownPlugin {
  manifest: PluginManifest
  messages: PluginMessages
  loaded: LoadedPlugin
  properties: PluginSettingProperty[]
  tables: ReadonlySet<string>
  /** 官方插件随发行包分发、在核心进程内运行；安装插件在 plugin host 里运行 */
  official: boolean
  /**
   * 安装插件在本实例上解开的包。取不到表里这个版本的包时为 null：后台仍显示上一次的 manifest，
   * 插件不启用、不加载，按不可用处理（拦截注册的按失败策略关闭注册）
   */
  local: LocalPluginPackage | null
}

interface ActivePlugin {
  known: KnownPlugin
  granted: ReadonlySet<Capability>
  /** 登记过的任务名和定时任务名，停用时按它们撤销 */
  registered: { jobs: string[]; events: [string, string][]; schedules: string[] }
  /** host 不可用时为 false：任务处理函数（含事件订阅）照常登记、入队照常，执行器暂停认领（JobHandler.paused） */
  runnable: boolean
  /** 这一次启用已经停用：停用时只能取消已经开始的调用，还在准备上下文的调用靠它拦下 */
  stopped: boolean
}

export interface PluginHostStatus {
  /** 本进程能不能运行安装插件；命令行脚本不拉起 host */
  enabled: boolean
  state: 'idle' | 'running' | 'restarting' | 'failed' | 'disabled'
  generation: number | null
  plugins: string[]
  lastError: string | null
  /** host 的进程权限能不能拦住插件直接连网（Node 25 起才能） */
  networkRestricted: boolean
}

interface Invocation {
  pluginId: string
  known: KnownPlugin
  granted: ReadonlySet<Capability>
  kind: PluginCall['kind']
  /** 事务内的拦截器：插件的语句在这个事务上执行 */
  transaction?: Kysely<CoreDatabase>
  allowDdl: boolean
  deadline: number
  controller: AbortController
}

export const pluginJobName = (pluginId: string, job: string) => `plugin:${pluginId}:job:${job}`
export const pluginEventJobName = (pluginId: string, event: string) => `plugin:${pluginId}:on:${event}`
export const pluginScheduleName = (pluginId: string, index: number) => `plugin:${pluginId}:cron:${index}`

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const expected = pattern.split('/')
  const actual = path.split('/')
  if (expected.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < expected.length; i++) {
    const part = expected[i]!
    if (part.startsWith(':')) {
      if (!actual[i]) return null
      try {
        params[part.slice(1)] = decodeURIComponent(actual[i]!)
      } catch {
        return null
      }
    } else if (part !== actual[i]) return null
  }
  return params
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPluginSystem(options: {
  db: Kysely<CoreDatabase>
  dialect: CoreDialect
  secretKey: string
  settings: ReturnType<typeof createSettingQueries>
  jobs: JobRunner
  handlers: Map<string, JobHandler>
  events: Events
  schedules: ReturnType<typeof createScheduler>
  storage: TextureStorage
  gateway: PluginDbExecutor
  official: readonly OfficialPlugin[]
  now: () => Date
  log?: (line: string) => void
  syncIntervalMs?: number
  /** 加载官方插件的方式：默认在本进程内加载；测试换成别的实现 */
  load?: typeof loadPlugin
  /** plugin host 的入口；没有时安装插件不运行（命令行脚本只执行自己的用例） */
  host?: PluginHostEntry | null
  /** 安装插件的包和解开后的目录；没有时只认官方插件 */
  packages?: PluginPackages | null
  /** host 崩溃后的重启策略；测试用来缩短等待 */
  hostRestart?: { maxCrashes?: number; baseDelayMs?: number }
}) {
  const { db, handlers, events, schedules, gateway, now } = options
  const log = options.log ?? ((line: string) => console.info(line))
  const kv = createPluginKv(db, now)
  const coreData = createPluginCoreData(db, options.storage)
  const pluginSettings = createPluginSettings(db, options.secretKey, now)
  const invocations = new Map<string, Invocation>()
  const known = new Map<string, KnownPlugin>()
  const active = new Map<string, ActivePlugin>()
  const breakers = new Map<string, { failures: number; openUntil: number }>()
  const officialIds = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let syncing: Promise<void> | undefined
  let running = false

  /** 当前这一代 host；换代、启用安装插件这些改动一次只做一件（exclusive） */
  let generation: HostGeneration | undefined
  /** 还活着的每一代：当前的、准备切换过去的、正在退役的。取消调用时都通知一遍 */
  const generations = new Set<HostGeneration>()
  let generationSequence = 0
  const hostState = {
    /** 最近一次应该运行的组合，空串表示没有安装插件要运行 */
    desiredKey: '',
    lastError: null as string | null,
    crashes: [] as number[],
    /** 连续崩溃后停止自动重启的组合：等管理员在插件页重启 */
    failedKey: null as string | null,
    retryKey: null as string | null,
    retryAt: 0,
    startFailures: 0,
  }
  let lock: Promise<unknown> = Promise.resolve()
  const warned = new Set<string>()
  /**
   * 表里启用了、本实例却登记不上的插件（取不到包、manifest 不对、登记时出错）。值是要不要因此关闭注册：
   * 连 manifest 都没有时不知道它拦不拦截注册，按拦截处理（失败策略 closed，ADR-0033）
   */
  const unavailable = new Map<string, boolean>()

  for (const plugin of options.official) {
    const manifest = buildManifest(plugin.definition, plugin.package)
    if (known.has(manifest.id)) throw new Error(`官方插件 ${manifest.id} 重复`)
    officialIds.add(manifest.id)
    known.set(manifest.id, {
      manifest,
      messages: plugin.messages,
      properties: settingProperties(manifest),
      tables: new Set(manifest.tables),
      official: true,
      local: null,
      loaded: (options.load ?? loadPlugin)({
        id: manifest.id,
        version: manifest.version,
        definition: plugin.definition,
        messages: plugin.messages,
        dialect: options.dialect,
        fallbackLocale: 'zh-CN',
        rpc: (invocationId, method, args) => inProcessRpc(invocationId, method, args),
      }),
    })
  }

  /** 换代、启用和升级安装插件这些改动依次进行：同一时刻只有一个人在决定下一代是谁 */
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }

  /** 安装插件的调用交给 target() 那一代；那一代没有加载这个包时按不可用处理 */
  function hostedLoaded(id: string, hash: string, target: () => HostGeneration | undefined): LoadedPlugin {
    return {
      id,
      invoke(call, context) {
        const current = target()
        if (!current?.alive || current.plugins.get(id)?.hash !== hash) return Promise.reject(unavailableError())
        return current.call(id, call, context)
      },
      cancel(invocationId) {
        for (const item of generations) item.cancel(invocationId)
      },
      unload() {},
    }
  }

  function installedKnown(local: LocalPluginPackage, target: () => HostGeneration | undefined): KnownPlugin {
    return {
      manifest: local.manifest,
      messages: local.messages,
      properties: settingProperties(local.manifest),
      tables: new Set(local.manifest.tables),
      official: false,
      local,
      loaded: hostedLoaded(local.id, local.hash, target),
    }
  }

  const hosted = (local: LocalPluginPackage): HostedPlugin => ({
    id: local.id,
    version: local.version,
    dir: local.dir,
    entry: local.manifest.entry.server ?? '',
    messages: local.messages,
    manifest: local.manifest,
    hash: local.hash,
  })

  /** 这个插件现在能不能被调用：官方插件总是能；安装插件要当前这一代加载了它的这个包 */
  function runnable(plugin: KnownPlugin): boolean {
    if (plugin.official) return true
    return (
      !!plugin.local && !!generation?.alive && generation.plugins.get(plugin.manifest.id)?.hash === plugin.local.hash
    )
  }

  function setRunnable(state: ActivePlugin, value: boolean) {
    if (state.stopped) return
    if (state.runnable !== value) log(`[plugins] ${state.known.manifest.id} ${value ? 'runnable' : 'suspended'}`)
    state.runnable = value
  }

  async function startGeneration(plugins: readonly HostedPlugin[]): Promise<HostGeneration> {
    if (!options.host) throw new HostStartError('本进程不运行安装插件')
    const started = await startHostGeneration({
      entry: options.host,
      dialect: options.dialect,
      fallbackLocale: 'zh-CN',
      plugins,
      sequence: ++generationSequence,
      onRequest: (invocationId, method, args) => handleRequest(invocationId, method as CoreMethod, args as never),
      onExit: (exited, detail) => onHostExit(exited, detail),
      log,
    })
    generations.add(started)
    return started
  }

  function dispose(item: HostGeneration, how: 'retire' | 'kill') {
    void (how === 'retire' ? item.retire() : item.kill()).finally(() => generations.delete(item))
  }

  function onHostExit(exited: HostGeneration, detail: string) {
    generations.delete(exited)
    if (exited !== generation) return
    generation = undefined
    for (const state of active.values()) if (!state.known.official) setRunnable(state, false)
    const at = Date.now()
    hostState.crashes = hostState.crashes.filter((time) => at - time < CRASH_WINDOW_MS)
    hostState.crashes.push(at)
    if (hostState.crashes.length >= (options.hostRestart?.maxCrashes ?? MAX_CRASHES)) {
      hostState.failedKey = exited.key
      // 只记诊断信息（退出码、信号），说明的话由后台按语言写
      hostState.lastError = detail
      log(`[plugins] host_failed crashes=${hostState.crashes.length}`)
      return
    }
    const delay = Math.min((options.hostRestart?.baseDelayMs ?? 1000) * 2 ** (hostState.crashes.length - 1), 30_000)
    hostState.retryKey = exited.key
    hostState.retryAt = at + delay
    hostState.lastError = detail
    if (running) scheduleSync(delay)
  }

  /**
   * 表里安装插件的行 → 本实例上的包：没解开的版本从存储接口取下来（多实例部署）。
   * 已经卸载的从 known 里去掉
   */
  async function refreshInstalled(
    rows: readonly { id: string; version: string; package_hash: string | null }[],
  ): Promise<void> {
    for (const [id, plugin] of [...known]) {
      if (plugin.official || rows.some((row) => row.id === id && row.package_hash !== null)) continue
      if (active.has(id)) deactivate(id)
      known.delete(id)
    }
    if (!options.packages) return
    for (const row of rows) {
      const hash = row.package_hash
      if (hash === null || officialIds.has(row.id)) continue
      const current = known.get(row.id)
      if (current?.local && current.local.version === row.version && current.local.hash === hash) continue
      let local: LocalPluginPackage | null = null
      try {
        local = await options.packages.ensure(row.id, row.version, hash)
      } catch (error) {
        log(`[plugins] ${row.id} package_failed ${errorMessage(error)}`)
      }
      if (!local) {
        if (!warned.has(hash)) log(`[plugins] ${row.id} package_unavailable version=${row.version}`)
        warned.add(hash)
        // 取不到新版本的包：留着上一次的 manifest 给后台显示，但不启用它、不加载旧的代码（syncLocked），下次同步再取
        if (current?.local) known.set(row.id, { ...current, local: null })
        continue
      }
      try {
        known.set(
          row.id,
          installedKnown(local, () => generation),
        )
      } catch (error) {
        log(`[plugins] ${row.id} manifest_invalid ${errorMessage(error)}`)
      }
    }
  }

  /** 表里启用的安装插件和当前这一代不一致就换代；candidate 是管理员操作时已经拉起、跑过迁移的新一代 */
  async function reconcile(
    rows: readonly { id: string; is_enabled: 0 | 1; package_hash: string | null }[],
    candidate?: HostGeneration,
  ): Promise<void> {
    const desired = rows.flatMap((row) => {
      const plugin = row.is_enabled === 1 && row.package_hash !== null ? known.get(row.id) : undefined
      return plugin && !plugin.official && plugin.local ? [hosted(plugin.local)] : []
    })
    const key = generationKey(desired)
    hostState.desiredKey = key
    // 管理员操作时拉起的那一代在改表的这段时间里可能已经退出了：不能切换到死掉的一代，按常规重新拉起
    if (candidate && (candidate.key !== key || !candidate.alive)) {
      dispose(candidate, 'kill')
      candidate = undefined
    }
    if (generation?.alive && generation.key === key) {
      if (candidate) dispose(candidate, 'kill')
      return
    }
    if (!desired.length || !options.host) {
      if (generation) dispose(generation, 'retire')
      generation = undefined
      return
    }
    if (!candidate) {
      if (hostState.failedKey === key) return
      if (hostState.retryKey === key && Date.now() < hostState.retryAt) return
      try {
        candidate = await startGeneration(desired)
      } catch (error) {
        hostState.startFailures++
        hostState.retryKey = key
        hostState.retryAt =
          Date.now() + Math.min(START_RETRY_MS * 2 ** (hostState.startFailures - 1), START_RETRY_MAX_MS)
        hostState.lastError = errorMessage(error)
        log(`[plugins] host_start_failed ${errorMessage(error)}`)
        return
      }
    }
    const previous = generation
    generation = candidate
    hostState.startFailures = 0
    hostState.retryKey = null
    hostState.failedKey = null
    hostState.lastError = null
    if (previous) dispose(previous, 'retire')
    log(`[plugins] host_generation ${candidate.sequence} ${key}`)
  }

  /** 官方插件的请求同样克隆一次；错误只带名字、消息和 code，和跨进程时一样 */
  async function inProcessRpc<M extends CoreMethod>(
    invocationId: string,
    method: M,
    args: CoreRequests[M]['args'],
  ): Promise<CoreRequests[M]['result']> {
    try {
      return structuredClone(await handleRequest(invocationId, method, structuredClone(args)))
    } catch (error) {
      throw Object.assign(new Error(errorMessage(error)), {
        name: error instanceof Error ? error.name : 'Error',
        ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}),
      })
    }
  }

  function remaining(invocation: Invocation): number {
    const left = invocation.deadline - Date.now()
    if (left <= 0) throw new PluginCallRejected('这次调用已经超时')
    return left
  }

  function require(invocation: Invocation, ...any: Capability[]) {
    if (!any.some((capability) => invocation.granted.has(capability)))
      throw new PluginCallRejected(`插件没有被授予 ${any.join(' 或 ')} 能力`)
  }

  async function handleRequest<M extends CoreMethod>(
    invocationId: string,
    method: M,
    args: CoreRequests[M]['args'],
  ): Promise<CoreRequests[M]['result']> {
    const invocation = invocations.get(invocationId)
    if (!invocation) throw new PluginCallRejected('这次调用已经结束，不能再访问核心')
    const a = args as Record<string, unknown>
    const id = invocation.pluginId
    if (method === 'log') {
      const level = ['debug', 'info', 'warn', 'error'].includes(String(a.level)) ? String(a.level) : 'info'
      const fields = a.fields === undefined ? '' : ` ${[...JSON.stringify(a.fields)].slice(0, 2000).join('')}`
      log(`[plugin:${id}] ${level} ${[...String(a.message)].slice(0, 1000).join('')}${fields}`)
      return null
    }
    // 事务内的拦截器只等得起本地的数据库操作；迁移和设置校验也只碰自己的表（ADR-0033）
    if ((invocation.transaction || invocation.kind === 'migrate') && method !== 'db.query')
      throw new PluginCallRejected(`事务内的拦截器和迁移里不能调用 ${method}`)
    if (invocation.kind === 'validateSettings') throw new PluginCallRejected('校验设置时不能访问核心')
    const result = await (async (): Promise<unknown> => {
      switch (method) {
        case 'db.query':
          require(invocation, 'storage.tables')
          return gateway.execute(
            {
              pluginId: id,
              tables: invocation.known.tables,
              allowDdl: invocation.allowDdl,
              transaction: invocation.transaction,
              timeoutMs: remaining(invocation),
            },
            a.node,
          )
        case 'kv.get':
          require(invocation, 'storage.kv')
          return kv.get(id, a.key)
        case 'kv.set':
          require(invocation, 'storage.kv')
          await kv.set(id, a.key, a.value, a.ttlSec)
          return null
        case 'kv.delete':
          require(invocation, 'storage.kv')
          await kv.delete(id, a.key)
          return null
        case 'jobs.enqueue':
          return enqueue(invocation, a)
        case 'fetch':
          remaining(invocation)
          return pluginFetch(args as SerializedRequest, {
            network: invocation.known.manifest.network,
            signal: invocation.controller.signal,
          })
        case 'users.get':
          require(invocation, 'users.read', 'users.readPrivate')
          return coreData.user(a.uid, invocation.granted.has('users.readPrivate'))
        case 'users.getMany':
          require(invocation, 'users.read', 'users.readPrivate')
          return coreData.users(a.uids, invocation.granted.has('users.readPrivate'))
        case 'users.findByEmail':
          require(invocation, 'users.readPrivate')
          return coreData.userByEmail(a.email)
        case 'players.get':
          require(invocation, 'players.read')
          return coreData.player(a.pid)
        case 'players.findByName':
          require(invocation, 'players.read')
          return coreData.playerByName(a.name)
        case 'players.findByUuid':
          require(invocation, 'players.read')
          return coreData.playerByUuid(a.uuid)
        case 'players.listByUser':
          require(invocation, 'players.read')
          return coreData.playersOf(a.uid)
        case 'textures.get':
          require(invocation, 'textures.read')
          return coreData.texture(a.tid)
        case 'textures.findByHash':
          require(invocation, 'textures.read')
          return coreData.textureByHash(a.hash)
        case 'textures.files.read':
          require(invocation, 'textures.readFile')
          return coreData.textureFile(a.hash)
        default:
          throw new PluginCallRejected(`未知的请求 ${String(method)}`)
      }
    })()
    if (!invocations.has(invocationId)) throw new PluginCallRejected('这次调用已经结束')
    return result as CoreRequests[M]['result']
  }

  async function enqueue(invocation: Invocation, a: Record<string, unknown>): Promise<null> {
    const name = a.name
    if (typeof name !== 'string' || !invocation.known.manifest.jobs.some((job) => job.name === name))
      throw new PluginCallRejected(`任务 ${String(name)} 没有在 jobs 里声明`)
    const json = JSON.stringify(a.payload)
    if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_JOB_PAYLOAD_BYTES)
      throw new PluginCallRejected(`任务的载荷必须能转成 JSON，并且不超过 ${MAX_JOB_PAYLOAD_BYTES} 字节`)
    const delaySec = a.delaySec
    if (
      delaySec !== undefined &&
      (typeof delaySec !== 'number' || !Number.isSafeInteger(delaySec) || delaySec < 0 || delaySec > MAX_DELAY_SEC)
    )
      throw new PluginCallRejected(`delaySec 必须是 0 到 ${MAX_DELAY_SEC} 之间的整数`)
    const dedupeKey = a.dedupeKey
    if (dedupeKey !== undefined && typeof dedupeKey !== 'string') throw new PluginCallRejected('dedupeKey 必须是字符串')
    const jobName = pluginJobName(invocation.pluginId, name)
    if (!handlers.has(jobName)) throw new PluginCallRejected('插件已经停用')
    try {
      await options.jobs.enqueue(db, jobName, JSON.parse(json) as Json, {
        ...(delaySec !== undefined ? { delayMs: delaySec * 1000 } : {}),
        ...(dedupeKey !== undefined ? { dedupeKey } : {}),
      })
    } catch (error) {
      if (error instanceof RangeError) throw new PluginCallRejected(error.message)
      throw error
    }
    return null
  }

  async function site() {
    const values = await options.settings.read(['site.url', 'site.name', 'site.locale'])
    return { url: values['site.url'].replace(/\/+$/, ''), name: values['site.name'], locale: values['site.locale'] }
  }

  /**
   * 调用一次插件。超时、抛错、返回值不对都变成 PluginInvocationError；
   * 调用结束后这次 invocation 立即作废，插件留着 ctx 迟到的请求一律被拒绝
   */
  async function invoke(
    plugin: { known: KnownPlugin; granted: ReadonlySet<Capability>; stopped?: boolean },
    call: PluginCall,
    opts: { timeoutMs: number; locale?: string; transaction?: Kysely<CoreDatabase>; allowDdl?: boolean },
  ): Promise<unknown> {
    const id = plugin.known.manifest.id
    const invocationId = randomUUID()
    const controller = new AbortController()
    const started = Date.now()
    const point =
      call.kind === 'event'
        ? `on:${call.event.name}`
        : call.kind === 'intercept'
          ? `intercept:${call.name}`
          : call.kind === 'route'
            ? `route:${call.method} ${call.path}`
            : call.kind === 'job'
              ? `job:${call.name}`
              : call.kind === 'passwordHasher'
                ? `passwordHasher:${call.provider}`
                : call.kind
    let outcome = 'ok'
    let timer: ReturnType<typeof setTimeout> | undefined
    // 期限从调用开始算，读设置这些准备工作也算在里面：注册事务里的拦截器不能因为准备工作卡住而一直占着写锁
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PluginInvocationError(id, 'timeout', `插件在 ${opts.timeoutMs} ms 内没有完成`)),
        opts.timeoutMs,
      )
    })
    deadline.catch(() => {})
    try {
      const [values, info] = await Promise.race([
        Promise.all([
          call.kind === 'migrate' || call.kind === 'validateSettings'
            ? Promise.resolve({})
            : pluginSettings.read(id, plugin.known.properties),
          site(),
        ]),
        deadline,
      ])
      // 准备的这段时间里插件可能被停用了：停用时取消的只是已经开始的调用，这里不能再开始新的
      if (plugin.stopped) throw new PluginInvocationError(id, 'unavailable', '插件已经停用')
      invocations.set(invocationId, {
        pluginId: id,
        known: plugin.known,
        granted: plugin.granted,
        kind: call.kind,
        transaction: opts.transaction,
        allowDdl: opts.allowDdl ?? false,
        deadline: started + opts.timeoutMs,
        controller,
      })
      const context = {
        invocationId,
        settings: values,
        site: { url: info.url, name: info.name },
        locale: opts.locale ?? info.locale,
        timeoutMs: Math.max(1, started + opts.timeoutMs - Date.now()),
      }
      const execution = plugin.known.loaded.invoke(structuredClone(call), structuredClone(context))
      const result = await Promise.race([
        execution.then(
          (value) => {
            // 插件侧的计时和这里不完全同步：过了期限才到的结果按超时处理
            if (Date.now() >= started + opts.timeoutMs)
              throw new PluginInvocationError(id, 'timeout', `插件在 ${opts.timeoutMs} ms 内没有完成`)
            return structuredClone(value)
          },
          (error: unknown) => {
            const name = error instanceof Error ? error.name : ''
            throw new PluginInvocationError(
              id,
              name === 'PluginSettingsInvalidError'
                ? 'settings_invalid'
                : name === 'PluginTimeoutError'
                  ? 'timeout'
                  : // 只认核心这边判断的不可用：插件抛出的同名错误（错误名经 host 原样传回来）照常算失败，不能让任务无限推迟
                    error instanceof PluginHostUnavailableError
                    ? 'unavailable'
                    : 'error',
              name === 'PluginTimeoutError' ? `插件在 ${opts.timeoutMs} ms 内没有完成` : errorMessage(error),
            )
          },
        ),
        deadline,
      ])
      return result
    } catch (error) {
      outcome = error instanceof PluginInvocationError ? error.reason : 'error'
      if (error instanceof PluginInvocationError) throw error
      throw new PluginInvocationError(id, 'error', errorMessage(error))
    } finally {
      clearTimeout(timer)
      invocations.delete(invocationId)
      controller.abort()
      // 超时了插件那边可能还在跑：让它的 ctx.signal 也中止
      plugin.known.loaded.cancel(invocationId)
      // 第一版没有指标系统，只记日志：插件 id、调用点、耗时、结果（ADR-0033）
      log(`[plugins] ${id} ${point} ${Date.now() - started}ms ${outcome}`)
    }
  }

  const errorText = (error: unknown) => (error instanceof PluginInvocationError ? error.message || error.reason : null)

  /** 拿着这个插件的锁执行；别的实例正在操作同一个插件时报 plugin_busy。不可重入 */
  async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withExclusiveLock(db, lockName(id), fn)
    } catch (error) {
      if (error instanceof ExclusiveLockBusyError) throw new DomainError('plugin_busy')
      throw error
    }
  }

  /**
   * 插件表里没有这个 id 时它留下的东西：它的表（按物理名的前缀找，不依赖 manifest）、设置，
   * 以及卸载之后别的实例在同步之前又写进来的任务、定时任务条目和死信。KV 和迁移记录随插件表的行级联删掉了。
   * 调用方拿着这个插件的锁，并且确认了表里没有它
   */
  async function dropLeftovers(id: string): Promise<void> {
    await gateway.dropAllTables(id)
    const prefix = `plugin:${id}:%`
    await db.deleteFrom('jobs').where('name', 'like', prefix).execute()
    await db.deleteFrom('job_schedules').where('name', 'like', prefix).execute()
    await db.deleteFrom('failed_jobs').where('name', 'like', prefix).execute()
    await pluginSettings.clear(db, id)
  }

  /**
   * 卸载之后的清理，调用方拿着这个插件的锁。可以重复执行。又装回来了（表里有这个 id）就只删没在用的插件包：
   * 留下的东西在装回来之前已经由 runPendingCleanup 删过
   */
  async function cleanupLocked(cleanup: CleanupPayload): Promise<void> {
    const { id, hash } = cleanup
    const row = await db.selectFrom('plugins').select('package_hash').where('id', '=', id).executeTakeFirst()
    if (!row) await dropLeftovers(id)
    if (row?.package_hash === hash) return
    await options.packages?.store.delete(hash)
    await options.packages?.removeLocal(id, hash)
  }

  /** 清理任务（PLUGIN_CLEANUP_JOB）：别的实例正在操作这个插件（例如正在装回来）就推迟，不算一次尝试 */
  async function cleanupUninstalled(payload: unknown): Promise<void> {
    const cleanup = parseCleanup(payload)
    try {
      await withExclusiveLock(db, lockName(cleanup.id), () => cleanupLocked(cleanup))
    } catch (error) {
      if (error instanceof ExclusiveLockBusyError) throw new JobDeferredError()
      throw error
    }
  }

  /** host 不可用、插件刚被停用：这次根本没执行，任务放回队列，不算一次尝试（ADR-0033"事件和任务留在表里"） */
  const deferUnavailable = (error: unknown) =>
    error instanceof PluginInvocationError && error.reason === 'unavailable' ? new JobDeferredError() : error

  /** 跑还没跑过的迁移：DDL 只能在这里执行（ADR-0010）。安装插件的迁移在准备切换过去的那一代里跑 */
  async function runMigrations(plugin: KnownPlugin, timestamp: () => IsoTimestamp): Promise<void> {
    const id = plugin.manifest.id
    const done = new Set(
      (await db.selectFrom('plugin_migrations').select('name').where('plugin_id', '=', id).execute()).map(
        (row) => row.name,
      ),
    )
    for (const name of plugin.manifest.migrations) {
      if (done.has(name)) continue
      // 迁移时插件还没启用，能力按 manifest 申请的给：迁移只能访问它自己的表
      await invoke(
        { known: plugin, granted: new Set(plugin.manifest.capabilities) },
        { kind: 'migrate', name },
        { timeoutMs: MIGRATION_TIMEOUT_MS, allowDdl: true },
      )
      await db.insertInto('plugin_migrations').values({ plugin_id: id, name, executed_at: timestamp() }).execute()
    }
  }

  /** 新一代起不来：插件加载失败、实际的定义和 manifest 对不上。原因交给管理员 */
  function stageError(error: unknown): Error {
    if (error instanceof HostStartError)
      return new DomainError('plugin_load_failed', { message: [...error.message].slice(0, 300).join('') })
    return error instanceof Error ? error : new Error(String(error))
  }

  async function withTemporaryHost<T>(local: LocalPluginPackage, fn: (target: KnownPlugin) => Promise<T>): Promise<T> {
    if (!options.host) throw new DomainError('plugin_unavailable')
    let temporary: HostGeneration
    try {
      temporary = await startGeneration([hosted(local)])
    } catch (error) {
      throw stageError(error)
    }
    try {
      return await fn(installedKnown(local, () => temporary))
    } finally {
      dispose(temporary, 'kill')
    }
  }

  function activate(plugin: KnownPlugin, granted: ReadonlySet<Capability>) {
    const { manifest } = plugin
    const id = manifest.id
    const state: ActivePlugin = {
      known: plugin,
      granted,
      registered: { jobs: [], events: [], schedules: [] },
      // 执行器在这之后才看得到处理函数：host 就绪之前不会认领它的任务
      runnable: runnable(plugin),
      stopped: false,
    }
    active.set(id, state)
    const paused = () => !state.runnable
    for (const job of manifest.jobs) {
      const name = pluginJobName(id, job.name)
      handlers.set(name, {
        maxAttempts: job.maxAttempts,
        // 插件那边的超时先到，失败原因是插件的；执行器的超时只是兜底
        timeoutMs: job.timeoutMs + 1_000,
        errorText,
        paused,
        run: async ({ payload, attempt }) => {
          await invoke(
            state,
            { kind: 'job', name: job.name, payload: payload as Json, attempt },
            { timeoutMs: job.timeoutMs },
          ).catch((error: unknown) => {
            throw deferUnavailable(error)
          })
        },
      })
      state.registered.jobs.push(name)
    }
    for (const event of manifest.events) {
      const name = pluginEventJobName(id, event)
      events.subscribe(
        event,
        name,
        {
          timeoutMs: EVENT_TIMEOUT_MS + 1_000,
          errorText,
          paused,
          run: async ({ event: envelope }) => {
            await invoke(state, { kind: 'event', event: envelope }, { timeoutMs: EVENT_TIMEOUT_MS }).catch(
              (error: unknown) => {
                throw deferUnavailable(error)
              },
            )
          },
        },
        { pluginId: id },
      )
      state.registered.events.push([event, name])
    }
    manifest.cron.forEach((entry, index) => {
      const name = pluginScheduleName(id, index)
      schedules.add({ name, cron: entry.schedule, job: pluginJobName(id, entry.job), payload: entry.payload })
      state.registered.schedules.push(name)
    })
    log(`[plugins] ${id} activated version=${manifest.version}`)
  }

  function deactivate(id: string) {
    const state = active.get(id)
    if (!state) return
    state.stopped = true
    active.delete(id)
    for (const name of state.registered.schedules) schedules.remove(name)
    for (const [event, name] of state.registered.events) events.unsubscribe(event as never, name)
    for (const name of state.registered.jobs) handlers.delete(name)
    state.known.loaded.unload()
    log(`[plugins] ${id} deactivated`)
  }

  /**
   * 读 `plugins` 表里的启用集合：官方插件按它登记、撤销；安装插件先把本实例缺的包取下来，再决定要不要换代。
   * 只在 exclusive 里调用
   */
  async function syncLocked(candidate?: HostGeneration): Promise<void> {
    let rows
    try {
      rows = await db
        .selectFrom('plugins')
        .select(['id', 'version', 'is_enabled', 'capabilities', 'package_hash'])
        .execute()
    } catch (error) {
      if (candidate) dispose(candidate, 'kill')
      throw error
    }
    await refreshInstalled(rows)
    for (const [id, plugin] of known) {
      const row = rows.find((item) => item.id === id)
      let granted: Set<Capability> | null = null
      // 本实例上没有表里这个版本的包：不启用（旧版本的 manifest 和代码都不能代替新版本），下面按不可用处理
      if (row?.is_enabled === 1 && (plugin.official || plugin.local)) {
        try {
          const parsed = JSON.parse(row.capabilities) as unknown
          // 授予的能力和 manifest 申请的取交集：表里多出来的不算数
          granted = new Set(
            Array.isArray(parsed)
              ? plugin.manifest.capabilities.filter((capability) => parsed.includes(capability))
              : [],
          )
        } catch {
          granted = new Set()
        }
      }
      const current = active.get(id)
      const same =
        current &&
        granted &&
        current.known === plugin &&
        current.granted.size === granted.size &&
        [...granted].every((capability) => current.granted.has(capability))
      if (same) continue
      if (current) deactivate(id)
      if (!granted) continue
      try {
        activate(plugin, granted)
      } catch (error) {
        // 例如定时任务的 cron 调度器不认：撤销已经登记的部分，这个插件按不可用处理，别的插件照常
        deactivate(id)
        const key = `activate:${id}:${plugin.manifest.version}`
        if (!warned.has(key)) log(`[plugins] ${id} activate_failed ${errorMessage(error)}`)
        warned.add(key)
      }
    }
    unavailable.clear()
    for (const row of rows) {
      if (row.is_enabled !== 1 || active.has(row.id)) continue
      // 没有包就不知道这个版本拦不拦截注册：按拦截处理，注册按失败策略关闭
      const plugin = known.get(row.id)
      unavailable.set(
        row.id,
        !plugin ||
          (!plugin.official && !plugin.local) ||
          plugin.manifest.interceptors.some((item) => item.name === 'user.register'),
      )
    }
    await reconcile(rows, candidate)
    for (const state of active.values()) if (!state.known.official) setRunnable(state, runnable(state.known))
    // 不运行 host 的进程（命令行脚本）不清理：服务进程可能正在用它们不认识的目录
    if (options.packages && options.host) {
      // 当前这一代、正在退役的那一代还在读的目录也留着
      const keep = new Set<string>()
      for (const plugin of known.values()) if (plugin.local) keep.add(plugin.local.dir)
      for (const item of generations) for (const plugin of item.plugins.values()) keep.add(plugin.dir)
      await options.packages.prune(keep).catch((error: unknown) => log(`[plugins] prune_failed ${errorMessage(error)}`))
    }
  }

  function scheduleSync(delayMs = options.syncIntervalMs ?? SYNC_INTERVAL_MS) {
    clearTimeout(timer)
    timer = setTimeout(() => void tick(), delayMs)
    timer.unref()
  }

  function tick(): Promise<void> {
    syncing ??= exclusive(() => syncLocked())
      .catch((error: unknown) => log(`[plugins] sync_failed ${error instanceof Error ? error.name : 'error'}`))
      .finally(() => {
        syncing = undefined
        if (running) scheduleSync()
      })
    return syncing
  }

  function breakerKey(id: string, point: string) {
    return `${id}:${point}`
  }

  function breakerOpen(key: string): boolean {
    const breaker = breakers.get(key)
    return !!breaker && breaker.openUntil > Date.now()
  }

  function recordFailure(key: string) {
    const breaker = breakers.get(key) ?? { failures: 0, openUntil: 0 }
    breaker.failures++
    if (breaker.failures >= BREAKER_THRESHOLD) {
      breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS
      breaker.failures = 0
      log(`[plugins] breaker_open ${key} cooldown=${BREAKER_COOLDOWN_MS}ms`)
    }
    breakers.set(key, breaker)
  }

  function activeWith<K extends keyof PluginManifest>(key: K, test: (value: PluginManifest[K]) => boolean) {
    return [...active.values()].filter((plugin) => test(plugin.known.manifest[key]))
  }

  /** detect.pattern 编译后的正则，按源码缓存；manifest 校验时已经确认能编译 */
  const patterns = new Map<string, RegExp>()
  function detects(detect: PluginManifest['providers']['passwordHasher'][number]['detect'], hash: string): boolean {
    if (detect.prefix?.some((prefix) => hash.startsWith(prefix))) return true
    if (detect.pattern === undefined) return false
    let pattern = patterns.get(detect.pattern)
    if (!pattern) {
      pattern = new RegExp(detect.pattern, 'u')
      patterns.set(detect.pattern, pattern)
    }
    return pattern.test(hash)
  }

  return {
    /** 启动时先切到表里的启用集合，再开始轮询；执行器在这之后才启动，插件的任务不会被漏认领 */
    async start(): Promise<void> {
      if (running) return
      await exclusive(() => syncLocked())
      running = true
      scheduleSync()
    },
    async stop(): Promise<void> {
      running = false
      clearTimeout(timer)
      await syncing
      await exclusive(async () => {
        for (const id of [...active.keys()]) deactivate(id)
        generation = undefined
        await Promise.all([...generations].map((item) => item.kill()))
        generations.clear()
      })
    },
    /**
     * 管理员改了启用状态之后，本实例立即切换，不等下一次轮询。总是在改动提交之后重新读表：
     * 不能复用正在进行的那次轮询，它可能是在改动提交之前读的
     */
    sync: () => exclusive(() => syncLocked()),
    /**
     * 管理员启用、升级安装插件：在 exclusive 里先拉起包含新版本的一代（health check）、在它里面跑迁移，
     * 确认没问题再改表，然后切换过去。fn 抛错时这一代被杀掉，当前这一代不受影响（ADR-0033）
     */
    stage<T>(
      local: LocalPluginPackage,
      fn: (staged: { migrate(timestamp: () => IsoTimestamp): Promise<void> }) => Promise<T>,
    ): Promise<T> {
      return exclusive(async () => {
        if (!options.host) throw new DomainError('plugin_unavailable')
        const others = [...active.values()].flatMap((state) =>
          !state.known.official && state.known.local && state.known.manifest.id !== local.id
            ? [hosted(state.known.local)]
            : [],
        )
        let candidate: HostGeneration
        try {
          candidate = await startGeneration([...others, hosted(local)])
        } catch (error) {
          throw stageError(error)
        }
        let result: T
        try {
          const target = installedKnown(local, () => candidate)
          result = await fn({ migrate: (timestamp) => runMigrations(target, timestamp) })
        } catch (error) {
          dispose(candidate, 'kill')
          throw error
        }
        await syncLocked(candidate)
        return result
      })
    },
    withTemporaryHost,
    /** 连续崩溃之后，管理员在插件页手动重启 host */
    restartHost: () =>
      exclusive(async () => {
        hostState.failedKey = null
        hostState.retryKey = null
        hostState.crashes = []
        hostState.startFailures = 0
        await syncLocked()
      }),
    hostStatus(): PluginHostStatus {
      const current = generation?.alive ? generation : undefined
      return {
        enabled: !!options.host,
        state: !options.host
          ? 'disabled'
          : current
            ? 'running'
            : hostState.failedKey !== null && hostState.failedKey === hostState.desiredKey
              ? 'failed'
              : hostState.desiredKey
                ? 'restarting'
                : 'idle',
        generation: current?.sequence ?? null,
        plugins: current ? [...current.plugins.keys()].sort() : [],
        lastError: hostState.lastError,
        networkRestricted: hostNetworkRestricted,
      }
    },
    packages: options.packages ?? null,
    isOfficial: (id: string) => officialIds.has(id),
    dropTables: (id: string, tables: readonly string[]) => gateway.dropTables(id, tables),
    withLock,
    /** 在卸载的事务里登记：过一会儿删掉它的表、存储里的插件包和本实例解开的目录。任务在表里，进程退出也不会丢 */
    async scheduleCleanup(tx: Kysely<CoreDatabase>, cleanup: CleanupPayload): Promise<void> {
      const payload: CleanupPayload = { id: cleanup.id, hash: cleanup.hash }
      await options.jobs.enqueue(tx, PLUGIN_CLEANUP_JOB, payload, {
        delayMs: CLEANUP_DELAY_MS,
        dedupeKey: cleanupKey(cleanup.id),
      })
    },
    cleanupUninstalled,
    /**
     * 第一次安装、或者卸载之后又装回同一个 id：从空状态开始。先把上次卸载还没做的清理做掉（删旧的插件包），
     * 再删它留下的表、设置和任务：清理任务可能进了死信、死信又过了保留期被删掉，不能只靠它们。
     * 调用方拿着这个插件的锁，别的实例上的清理任务这时只能推迟。旧的一代这时可能还有在途的调用，它们会失败：
     * 这是管理员自己的操作
     */
    async runPendingCleanup(id: string): Promise<void> {
      // 拿到锁之前别的实例可能刚装好了它：这时什么也不删，提交时按冲突处理
      if (await db.selectFrom('plugins').select('id').where('id', '=', id).executeTakeFirst()) return
      for (const table of ['jobs', 'failed_jobs'] as const) {
        const rows = await db
          .selectFrom(table)
          .select(['id', 'payload'])
          .where('name', '=', PLUGIN_CLEANUP_JOB)
          .where('dedupe_key', '=', cleanupKey(id))
          .execute()
        for (const row of rows) {
          await cleanupLocked(parseCleanup(JSON.parse(row.payload)))
          await db.deleteFrom(table).where('id', '=', row.id).execute()
        }
      }
      await dropLeftovers(id)
    },
    known: (): KnownPlugin[] => [...known.values()],
    get: (id: string): KnownPlugin | undefined => known.get(id),
    isActive: (id: string) => active.has(id),
    /** 正在本实例上运行：启用了，并且能被调用（安装插件要 host 加载了它） */
    isRunning: (id: string) => {
      const state = active.get(id)
      return !!state && runnable(state.known)
    },
    invoke,
    settingsStore: pluginSettings,
    kv,

    /** 注册表单上各插件加的字段，按插件 id 排序 */
    registerFields(): PluginFormField[] {
      return [...active.values()]
        .sort((a, b) => a.known.manifest.id.localeCompare(b.known.manifest.id))
        .flatMap((plugin) =>
          (plugin.known.manifest.ui.formFields ?? [])
            .filter((item) => item.form === 'auth.register')
            .map((item) => ({ pluginId: plugin.known.manifest.id, field: item.field })),
        )
    },

    /**
     * `user.register` 拦截器：在注册事务内按 priority、插件 id 依次调用，任何一个拒绝就短路。
     * 失败策略是 closed：超时、抛错、熔断中都拒绝注册（ADR-0033）
     */
    async interceptRegister(
      tx: Kysely<CoreDatabase>,
      input: Omit<CoreInterceptors['user.register']['input'], 'extra'>,
      extra: ReadonlyMap<string, ExtraFields>,
      scope: RequestScope,
    ): Promise<void> {
      const name = 'user.register'
      const policy = interceptorPolicies[name]
      for (const [id, closes] of unavailable)
        if (closes) {
          log(`[plugins] ${id} intercept_failed ${name} unavailable`)
          throw new DomainError('plugin_unavailable')
        }
      const list = activeWith('interceptors', (items) => items.some((item) => item.name === name))
        .map((plugin) => ({
          plugin,
          priority: plugin.known.manifest.interceptors.find((item) => item.name === name)!.priority,
        }))
        .sort((a, b) => a.priority - b.priority || a.plugin.known.manifest.id.localeCompare(b.plugin.known.manifest.id))
      for (const { plugin } of list) {
        const id = plugin.known.manifest.id
        const key = breakerKey(id, `intercept:${name}`)
        if (breakerOpen(key)) throw new DomainError('plugin_unavailable')
        let outcome: unknown
        try {
          outcome = await invoke(
            plugin,
            { kind: 'intercept', name, input: { ...input, extra: extra.get(id) ?? {} }, scope },
            { timeoutMs: policy.timeoutMs, locale: scope.locale, transaction: policy.transactional ? tx : undefined },
          )
        } catch (error) {
          recordFailure(key)
          // 插件抛出的消息由插件负责，留给作者排查；核心自己的错误消息里不带请求数据
          log(
            error instanceof PluginInvocationError
              ? `[plugins] ${id} intercept_failed ${name} ${error.reason} ${[...error.message].slice(0, 300).join('')}`
              : `[plugins] ${id} intercept_failed ${name} error`,
          )
          throw new DomainError('plugin_unavailable')
        }
        // 插件侧可能被完全控制：返回值在这里再检查一遍，合法的返回值才清掉失败计数
        const deny = outcome as InterceptOutcome
        if (deny === null) {
          breakers.delete(key)
          continue
        }
        if (
          typeof deny === 'object' &&
          deny.action === 'deny' &&
          typeof deny.code === 'string' &&
          typeof deny.message === 'string'
        ) {
          breakers.delete(key)
          throw new DomainError('registration_denied', {
            plugin: id,
            reason: [...deny.code].slice(0, 64).join(''),
            message: [...deny.message].slice(0, 200).join(''),
          })
        }
        recordFailure(key)
        throw new DomainError('plugin_unavailable')
      }
    },

    /**
     * passwordHasher：哈希既不是当前算法、也不是 BS 旧格式时由 auth/password.ts 调用。先在本进程内按 detect 匹配，
     * 匹配上了才调用插件，按插件 id、声明顺序依次调用，有一个通过就算通过。超时、抛错、返回值不对、熔断中都按不通过处理：
     * 插件不可用时这些用户登录不了，不能放行（ADR-0033）。参数里有明文密码，日志只记插件 id、Provider 和失败原因，
     * 不记插件抛出的消息
     */
    async verifyPassword(input: { hash: string; password: string }): Promise<boolean> {
      if (input.hash.length > MAX_PLUGIN_HASH_LENGTH) return false
      const list = activeWith('providers', (providers) => providers.passwordHasher.length > 0).sort((a, b) =>
        a.known.manifest.id.localeCompare(b.known.manifest.id),
      )
      for (const plugin of list) {
        const id = plugin.known.manifest.id
        for (const provider of plugin.known.manifest.providers.passwordHasher) {
          if (!detects(provider.detect, input.hash)) continue
          const key = breakerKey(id, `passwordHasher:${provider.id}`)
          if (breakerOpen(key)) continue
          let result: unknown
          try {
            result = await invoke(
              plugin,
              { kind: 'passwordHasher', provider: provider.id, password: input.password, hash: input.hash },
              { timeoutMs: PASSWORD_TIMEOUT_MS },
            )
          } catch (error) {
            recordFailure(key)
            log(
              `[plugins] ${id} password_verify_failed ${provider.id} ${error instanceof PluginInvocationError ? error.reason : 'error'}`,
            )
            continue
          }
          // 插件侧可能被完全控制：返回值在这里再检查一遍
          if (typeof result !== 'boolean') {
            recordFailure(key)
            log(`[plugins] ${id} password_verify_failed ${provider.id} invalid_result`)
            continue
          }
          breakers.delete(key)
          if (result) return true
        }
      }
      return false
    },

    /** `/plugins/{id}/*`：登录态和 Origin 已由 HTTP 层检查；这里检查权限、调用插件 */
    async route(input: PluginRouteRequest): Promise<SerializedResponse> {
      const plugin = active.get(input.pluginId)
      if (!plugin)
        throw new DomainError(unavailable.has(input.pluginId) ? 'plugin_unavailable' : 'plugin_route_not_found')
      let matched: { route: PluginManifest['routes'][number]; params: Record<string, string> } | undefined
      for (const route of plugin.known.manifest.routes) {
        if (route.method !== input.method) continue
        const params = matchPath(route.path, input.path)
        if (params) {
          matched = { route, params }
          break
        }
      }
      if (!matched) throw new DomainError('plugin_route_not_found')
      const { route, params } = matched
      if (route.auth === 'user') {
        if (!input.user) throw new DomainError('unauthenticated')
        if (input.user.role === 'banned') throw new DomainError('user_banned')
        if (route.permission !== null && !canPlugin(input.user.role)) throw new DomainError('permission_denied')
      }
      if (input.request.body && input.request.body.byteLength > route.maxBodyBytes)
        throw new DomainError('request_too_large')
      const actor = input.user
        ? { kind: 'user' as const, uid: input.user.uid, role: input.user.role }
        : { kind: 'system' as const }
      let result: unknown
      try {
        result = await invoke(
          plugin,
          {
            kind: 'route',
            method: route.method,
            path: route.path,
            params,
            request: input.request,
            scope: { requestId: randomUUID(), actor, locale: input.locale, ip: input.ip },
          },
          { timeoutMs: ROUTE_TIMEOUT_MS, locale: input.locale },
        )
      } catch (error) {
        if (error instanceof PluginInvocationError && error.reason === 'timeout')
          throw new DomainError('plugin_timeout')
        // 启用了但 host 不可用（崩溃后重启中、取不到包）：503，和拦截器的失败策略一致
        if (error instanceof PluginInvocationError && error.reason === 'unavailable')
          throw new DomainError('plugin_unavailable')
        throw new DomainError('plugin_error')
      }
      const response = result as SerializedResponse
      if (
        !response ||
        typeof response.status !== 'number' ||
        response.status < 200 ||
        response.status > 599 ||
        !Array.isArray(response.headers) ||
        (response.body !== null && !(response.body instanceof Uint8Array))
      )
        throw new DomainError('plugin_error')
      return response
    },

    /** 某个插件路由的元数据：HTTP 层用它决定请求体上限和限流。启用了、本实例上却不可用时报 plugin_unavailable */
    routeOf(pluginId: string, method: string, path: string) {
      const plugin = active.get(pluginId)
      if (!plugin) {
        if (unavailable.has(pluginId)) throw new DomainError('plugin_unavailable')
        return null
      }
      for (const route of plugin.known.manifest.routes)
        if (route.method === method && matchPath(route.path, path)) return route
      return null
    },

    /** 插件的文案；界面上渲染插件声明的标签用 */
    translate(pluginId: string, key: string, locale: string, params?: Readonly<Record<string, string | number>>) {
      const plugin = known.get(pluginId)
      if (!plugin) return key
      return translatePlugin(plugin.messages, key, { locale, fallbackLocale: 'zh-CN', params })
    },

    /** 当前启用的插件的界面声明（导航、页面），按插件 id 排序 */
    activeUi() {
      return [...active.values()]
        .map((plugin) => ({ id: plugin.known.manifest.id, ui: plugin.known.manifest.ui }))
        .sort((a, b) => a.id.localeCompare(b.id))
    },

    /** 官方插件启用之前跑还没跑过的迁移，DDL 只能在这里执行（ADR-0010）；安装插件的迁移在 stage 里跑 */
    async migrate(id: string, timestamp: () => IsoTimestamp): Promise<void> {
      const plugin = known.get(id)
      if (!plugin) throw new DomainError('plugin_not_found')
      await runMigrations(plugin, timestamp)
    },

    /**
     * 插件按它自己的 zod schema 校验设置（一次插件调用）。没在运行的安装插件临时拉起一个只有它的 host；
     * host 不可用时不能改插件设置（ADR-0033）
     */
    async validateSettings(
      id: string,
      values: Record<string, Json>,
    ): Promise<{ ok: boolean; fields: readonly string[] }> {
      const plugin = known.get(id)
      if (!plugin) throw new DomainError('plugin_not_found')
      const run = (target: KnownPlugin) =>
        invoke(
          { known: target, granted: new Set() },
          { kind: 'validateSettings', values },
          { timeoutMs: SETTINGS_TIMEOUT_MS },
        )
      let result: { ok?: unknown; fields?: unknown }
      try {
        if (runnable(plugin)) result = (await run(plugin)) as typeof result
        else if (plugin.local) result = (await withTemporaryHost(plugin.local, run)) as typeof result
        else throw new DomainError('plugin_unavailable')
      } catch (error) {
        if (!(error instanceof PluginInvocationError)) throw error
        throw new DomainError(
          error.reason === 'timeout'
            ? 'plugin_timeout'
            : error.reason === 'unavailable'
              ? 'plugin_unavailable'
              : 'plugin_error',
        )
      }
      const fields = Array.isArray(result?.fields)
        ? result.fields.filter((item): item is string => typeof item === 'string')
        : []
      return { ok: result?.ok === true, fields }
    },
  }
}

export type PluginSystem = ReturnType<typeof createPluginSystem>
export { MAX_KV_VALUE_BYTES }
