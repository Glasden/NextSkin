/**
 * 核心侧的插件运行时（ADR-0033）。
 *
 * - 每次调用插件都登记一个 invocation：插件在这次调用里发回的请求都带着它的 id，
 *   能不能执行 DDL、是不是加入核心事务、还剩多少时间，只由核心登记的 invocation 决定，不信任插件。
 * - 按 manifest 登记事件、任务、定时任务、拦截器和路由；按 `plugins` 表里授予的能力放行请求。
 * - 官方插件在核心进程内运行，同样经过这里的检查和超时；参数和返回值克隆一次，
 *   和跨进程时一样，在进程内就能发现不可序列化的数据。
 * - 每个实例每 5 秒读一次 `plugins` 表里的启用集合，和当前不一致就自己切换（多实例部署）。
 */
import { randomUUID } from 'node:crypto'
import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
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
import type { JobHandler, JobRunner } from '../jobs/runner.ts'
import type { createScheduler } from '../jobs/schedules.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import type { TextureStorage } from '../textures/storage.ts'
import { createPluginCoreData } from './core-data.ts'
import { PluginCallRejected, PluginInvocationError } from './errors.ts'
import { pluginFetch } from './fetch.ts'
import { createPluginKv, MAX_KV_VALUE_BYTES } from './kv.ts'
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

const SYNC_INTERVAL_MS = 5_000
const EVENT_TIMEOUT_MS = 60_000
const ROUTE_TIMEOUT_MS = 30_000
const MIGRATION_TIMEOUT_MS = 60_000
const SETTINGS_TIMEOUT_MS = 5_000
/** 同一个拦截器连续失败这么多次，就在冷却期内不再调用它，直接按失败策略处理（ADR-0033） */
const BREAKER_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 30_000
const MAX_JOB_PAYLOAD_BYTES = 64 * 1024
const MAX_DELAY_SEC = 30 * 86_400

interface KnownPlugin {
  manifest: PluginManifest
  messages: PluginMessages
  loaded: LoadedPlugin
  properties: PluginSettingProperty[]
  tables: ReadonlySet<string>
}

interface ActivePlugin {
  known: KnownPlugin
  granted: ReadonlySet<Capability>
  /** 登记过的任务名和定时任务名，停用时按它们撤销 */
  registered: { jobs: string[]; events: [string, string][]; schedules: string[] }
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
  /** 加载插件的方式：默认在本进程内加载；plugin host 和测试换成别的实现 */
  load?: typeof loadPlugin
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
  let timer: ReturnType<typeof setTimeout> | undefined
  let syncing: Promise<void> | undefined
  let running = false

  for (const plugin of options.official) {
    const manifest = buildManifest(plugin.definition, plugin.package)
    if (known.has(manifest.id)) throw new Error(`官方插件 ${manifest.id} 重复`)
    known.set(manifest.id, {
      manifest,
      messages: plugin.messages,
      properties: settingProperties(manifest),
      tables: new Set(manifest.tables),
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
    plugin: { known: KnownPlugin; granted: ReadonlySet<Capability> },
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
              : call.kind
    let outcome = 'ok'
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const [values, info] = await Promise.all([
        call.kind === 'migrate' || call.kind === 'validateSettings'
          ? Promise.resolve({})
          : pluginSettings.read(id, plugin.known.properties),
        site(),
      ])
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
          (value) => structuredClone(value),
          (error: unknown) => {
            const name = error instanceof Error ? error.name : ''
            throw new PluginInvocationError(
              id,
              name === 'PluginSettingsInvalidError' ? 'settings_invalid' : 'error',
              errorMessage(error),
            )
          },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PluginInvocationError(id, 'timeout', `插件在 ${opts.timeoutMs} ms 内没有完成`)),
            Math.max(1, started + opts.timeoutMs - Date.now()),
          )
        }),
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
      // 第一版没有指标系统，只记日志：插件 id、调用点、耗时、结果（ADR-0033）
      log(`[plugins] ${id} ${point} ${Date.now() - started}ms ${outcome}`)
    }
  }

  const errorText = (error: unknown) => (error instanceof PluginInvocationError ? error.message || error.reason : null)

  function activate(plugin: KnownPlugin, granted: ReadonlySet<Capability>) {
    const { manifest } = plugin
    const id = manifest.id
    const state: ActivePlugin = { known: plugin, granted, registered: { jobs: [], events: [], schedules: [] } }
    for (const job of manifest.jobs) {
      const name = pluginJobName(id, job.name)
      handlers.set(name, {
        maxAttempts: job.maxAttempts,
        // 插件那边的超时先到，失败原因是插件的；执行器的超时只是兜底
        timeoutMs: job.timeoutMs + 1_000,
        errorText,
        run: async ({ payload, attempt }) => {
          await invoke(
            state,
            { kind: 'job', name: job.name, payload: payload as Json, attempt },
            { timeoutMs: job.timeoutMs },
          )
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
          run: async ({ event: envelope }) => {
            await invoke(state, { kind: 'event', event: envelope }, { timeoutMs: EVENT_TIMEOUT_MS })
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
    active.set(id, state)
    log(`[plugins] ${id} activated version=${manifest.version}`)
  }

  function deactivate(id: string) {
    const state = active.get(id)
    if (!state) return
    active.delete(id)
    for (const name of state.registered.schedules) schedules.remove(name)
    for (const [event, name] of state.registered.events) events.unsubscribe(event as never, name)
    for (const name of state.registered.jobs) handlers.delete(name)
    state.known.loaded.unload()
    log(`[plugins] ${id} deactivated`)
  }

  /** 读 `plugins` 表里的启用集合，和当前这一代不同就切换 */
  async function sync(): Promise<void> {
    const rows = await db.selectFrom('plugins').select(['id', 'version', 'is_enabled', 'capabilities']).execute()
    for (const [id, plugin] of known) {
      const row = rows.find((item) => item.id === id)
      let granted: Set<Capability> | null = null
      if (row?.is_enabled === 1) {
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
        current.granted.size === granted.size &&
        [...granted].every((capability) => current.granted.has(capability))
      if (same) continue
      if (current) deactivate(id)
      if (granted) activate(plugin, granted)
    }
  }

  function scheduleSync() {
    clearTimeout(timer)
    timer = setTimeout(() => void tick(), options.syncIntervalMs ?? SYNC_INTERVAL_MS)
    timer.unref()
  }

  function tick(): Promise<void> {
    syncing ??= sync()
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

  return {
    /** 启动时先切到表里的启用集合，再开始轮询；执行器在这之后才启动，插件的任务不会被漏认领 */
    async start(): Promise<void> {
      if (running) return
      await sync()
      running = true
      scheduleSync()
    },
    async stop(): Promise<void> {
      running = false
      clearTimeout(timer)
      await syncing
      for (const id of [...active.keys()]) deactivate(id)
    },
    /** 管理员改了启用状态之后，本实例立即切换，不等下一次轮询 */
    sync: tick,
    known: (): KnownPlugin[] => [...known.values()],
    get: (id: string): KnownPlugin | undefined => known.get(id),
    isActive: (id: string) => active.has(id),
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
          log(
            `[plugins] ${id} intercept_failed ${name} ${error instanceof PluginInvocationError ? error.reason : 'error'}`,
          )
          throw new DomainError('plugin_unavailable')
        }
        breakers.delete(key)
        // 插件侧可能被完全控制：返回值在这里再检查一遍
        const deny = outcome as InterceptOutcome
        if (deny === null) continue
        if (
          typeof deny === 'object' &&
          deny.action === 'deny' &&
          typeof deny.code === 'string' &&
          typeof deny.message === 'string'
        )
          throw new DomainError('registration_denied', {
            plugin: id,
            reason: [...deny.code].slice(0, 64).join(''),
            message: [...deny.message].slice(0, 200).join(''),
          })
        recordFailure(key)
        throw new DomainError('plugin_unavailable')
      }
    },

    /** `/plugins/{id}/*`：登录态和 Origin 已由 HTTP 层检查；这里检查权限、调用插件 */
    async route(input: PluginRouteRequest): Promise<SerializedResponse> {
      const plugin = active.get(input.pluginId)
      if (!plugin) throw new DomainError('plugin_route_not_found')
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

    /** 某个插件路由的元数据：HTTP 层用它决定请求体上限和限流 */
    routeOf(pluginId: string, method: string, path: string) {
      const plugin = active.get(pluginId)
      if (!plugin) return null
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

    /** 跑还没跑过的迁移；启用之前调用。DDL 只能在这里执行（ADR-0010） */
    async migrate(id: string, timestamp: () => IsoTimestamp): Promise<void> {
      const plugin = known.get(id)
      if (!plugin) throw new DomainError('plugin_not_found')
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
    },

    async validateSettings(
      id: string,
      values: Record<string, Json>,
    ): Promise<{ ok: boolean; fields: readonly string[] }> {
      const plugin = known.get(id)
      if (!plugin) throw new DomainError('plugin_not_found')
      const result = (await invoke(
        { known: plugin, granted: new Set() },
        { kind: 'validateSettings', values },
        { timeoutMs: SETTINGS_TIMEOUT_MS },
      )) as { ok?: unknown; fields?: unknown }
      const fields = Array.isArray(result?.fields)
        ? result.fields.filter((item): item is string => typeof item === 'string')
        : []
      return { ok: result?.ok === true, fields }
    },
  }
}

export type PluginSystem = ReturnType<typeof createPluginSystem>
export { MAX_KV_VALUE_BYTES }
