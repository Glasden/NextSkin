/**
 * 从插件定义提取 manifest（ADR-0010 第 2 条）。
 *
 * 构建命令 `nextskin-plugin build` 用它生成 manifest.json；官方插件在核心进程内加载时也用它；
 * 新一代 plugin host 加载插件后再提取一次，和 manifest 比对（ADR-0033"只认 manifest"）。
 * 插件可以是手写 JS，所以这里同时在运行时检查定义的形状，不信任类型。
 */
import {
  capabilities as knownCapabilities,
  interceptorPolicies,
  type HttpMethod,
  type Json,
  type PluginDefinition,
  type PluginManifest,
  type PluginPackageField,
} from '@nextskin/plugin-sdk'
import { z } from 'zod'
import { eventNames } from './events.ts'

/** 核心实现的插件 API 版本。manifest 的 `api` 范围必须包含它 */
export const PLUGIN_API_VERSION = '1.0.0'

// 运行时按形状检查，类型参数取最宽的：具体插件的处理函数参数比这里窄，泛型位置上没有别的写法
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginDefinition = PluginDefinition<any, any, any, any>

/** manifest 里由定义决定的部分；health check 比对的就是它 */
export type PluginContributions = Omit<
  PluginManifest,
  'manifestVersion' | 'id' | 'version' | 'api' | 'requires' | 'conflicts' | 'entry' | 'integrity'
>

export interface PluginPackageJson {
  readonly name: string
  readonly version: string
  readonly nextskin: PluginPackageField
}

export const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** 表名、索引名：拼进物理名 `p_<id>__<名字>`，不允许连续下划线（S5） */
export const OBJECT_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const KEY = /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/
const ROUTE_KEY =
  /^(GET|POST|PUT|PATCH|DELETE) (\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*))*|\/)$/
const DEFAULT_BODY_BYTES = 1024 * 1024
const MAX_BODY_BYTES = 10 * 1024 * 1024

export class PluginDefinitionError extends Error {
  override name = 'PluginDefinitionError'
}

function fail(message: string): never {
  throw new PluginDefinitionError(message)
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${what} 必须是对象`)
  return value as Record<string, unknown>
}

function keys(value: unknown, what: string, pattern = KEY): string[] {
  const names = Object.keys(record(value, what))
  for (const name of names) if (!pattern.test(name)) fail(`${what} 的键 ${JSON.stringify(name)} 格式不对`)
  return names
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

/** 只能是 JSON：UI 声明和定时任务的载荷原样写进 manifest */
function json<T>(value: T, what: string): T {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) fail(`${what} 必须能转成 JSON`)
    return JSON.parse(text) as T
  } catch (error) {
    if (error instanceof PluginDefinitionError) throw error
    fail(`${what} 必须能转成 JSON`)
  }
}

export function describePlugin(definition: AnyPluginDefinition): PluginContributions {
  const d = record(definition, '插件定义')
  const allowed = new Set([
    'capabilities',
    'network',
    'settings',
    'permissions',
    'tables',
    'migrations',
    'on',
    'intercept',
    'providers',
    'routes',
    'jobs',
    'cron',
    'ui',
  ])
  for (const key of Object.keys(d)) if (!allowed.has(key)) fail(`插件定义里没有 ${key} 这一项`)

  if (!Array.isArray(d.capabilities)) fail('capabilities 必须是数组，没有就写 []')
  const capabilities = d.capabilities as unknown[]
  for (const capability of capabilities)
    if (!(knownCapabilities as readonly unknown[]).includes(capability))
      fail(`未知的能力 ${JSON.stringify(capability)}`)

  const network = (d.network ?? []) as unknown[]
  if (!Array.isArray(network)) fail('network 必须是数组')
  for (const origin of network) {
    let url: URL | undefined
    try {
      url = typeof origin === 'string' ? new URL(origin) : undefined
    } catch {
      url = undefined
    }
    if (!url || url.protocol !== 'https:' || url.origin !== origin)
      fail(`network 里只能写 https 的 origin，例如 https://api.example.com：${JSON.stringify(origin)}`)
  }

  let settingsSchema: PluginContributions['settingsSchema'] = null
  if (d.settings !== undefined) {
    if (!(d.settings instanceof z.ZodObject)) fail('settings 必须是 z.object(...)')
    settingsSchema = z.toJSONSchema(d.settings, { io: 'input' }) as PluginContributions['settingsSchema']
  }

  const permissions: Record<string, string> = {}
  for (const [name, label] of Object.entries(record(d.permissions, 'permissions'))) {
    if (!KEY.test(name)) fail(`权限名 ${JSON.stringify(name)} 格式不对`)
    if (typeof label !== 'string') fail(`权限 ${name} 的说明必须是文案键`)
    permissions[name] = label
  }

  const tables = keys(d.tables, 'tables', OBJECT_NAME)
  const migrations = Object.entries(record(d.migrations, 'migrations'))
    .map(([name, migration]) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) fail(`迁移名 ${JSON.stringify(name)} 格式不对`)
      if (!isFunction(record(migration, `迁移 ${name}`).up)) fail(`迁移 ${name} 没有 up`)
      return name
    })
    .sort()
  if (migrations.length && !capabilities.includes('storage.tables')) fail('有迁移的插件要申请 storage.tables')

  const events = Object.entries(record(d.on, 'on')).map(([name, handler]) => {
    if (!(eventNames as readonly string[]).includes(name)) fail(`未知的事件 ${name}`)
    if (!isFunction(handler)) fail(`事件 ${name} 的处理函数必须是函数`)
    return name as PluginContributions['events'][number]
  })

  const interceptors = Object.entries(record(d.intercept, 'intercept')).map(([name, registration]) => {
    if (!Object.hasOwn(interceptorPolicies, name)) fail(`未知的拦截点 ${name}`)
    const r = isFunction(registration) ? { handler: registration } : record(registration, `拦截器 ${name}`)
    for (const key of Object.keys(r)) if (key !== 'handler' && key !== 'priority') fail(`拦截器 ${name} 没有 ${key}`)
    if (!isFunction(r.handler)) fail(`拦截器 ${name} 的处理函数必须是函数`)
    const priority = r.priority ?? 100
    if (typeof priority !== 'number' || !Number.isSafeInteger(priority)) fail(`拦截器 ${name} 的 priority 必须是整数`)
    return { name: name as PluginContributions['interceptors'][number]['name'], priority }
  })

  const providers = record(d.providers, 'providers')
  for (const key of Object.keys(providers))
    if (key !== 'passwordHasher' && key !== 'login') fail(`未知的 Provider ${key}`)
  const list = (value: unknown, what: string) => {
    if (value === undefined) return []
    if (!Array.isArray(value)) fail(`${what} 必须是数组`)
    const ids = new Set<string>()
    return value.map((item) => {
      const p = record(item, what)
      if (typeof p.id !== 'string' || !KEY.test(p.id) || ids.has(p.id)) fail(`${what} 的 id 格式不对或重复`)
      ids.add(p.id)
      if (typeof p.label !== 'string') fail(`${what} ${p.id} 的 label 必须是文案键`)
      return p as Record<string, unknown> & { id: string; label: string }
    })
  }
  const passwordHasher = list(providers.passwordHasher, 'passwordHasher').map((p) => {
    if (!isFunction(p.verify)) fail(`passwordHasher ${p.id} 没有 verify`)
    const detect = record(p.detect, `passwordHasher ${p.id} 的 detect`)
    const prefix = detect.prefix
    const pattern = detect.pattern
    if (prefix !== undefined && (!Array.isArray(prefix) || !prefix.every((item) => typeof item === 'string' && item)))
      fail(`passwordHasher ${p.id} 的 detect.prefix 必须是非空字符串数组`)
    if (pattern !== undefined) {
      if (typeof pattern !== 'string') fail(`passwordHasher ${p.id} 的 detect.pattern 必须是正则源码`)
      try {
        new RegExp(pattern, 'u')
      } catch {
        fail(`passwordHasher ${p.id} 的 detect.pattern 不是合法的正则`)
      }
    }
    if (prefix === undefined && pattern === undefined) fail(`passwordHasher ${p.id} 的 detect 至少要有一项`)
    return {
      id: p.id,
      label: p.label,
      detect: {
        ...(prefix !== undefined ? { prefix: [...(prefix as string[])] } : {}),
        ...(pattern !== undefined ? { pattern: pattern } : {}),
      },
    }
  })
  const login = list(providers.login, 'login').map((p) => {
    if (!isFunction(p.authorizeUrl) || !isFunction(p.exchange)) fail(`login ${p.id} 要有 authorizeUrl 和 exchange`)
    if (typeof p.icon !== 'string') fail(`login ${p.id} 的 icon 必须是图标名`)
    return { id: p.id, label: p.label, icon: p.icon }
  })

  const declaredPermissions = new Set(Object.keys(permissions))
  const routes = Object.entries(record(d.routes, 'routes')).map(([key, route]) => {
    const match = ROUTE_KEY.exec(key)
    if (!match) fail(`路由键 ${JSON.stringify(key)} 必须是 'METHOD /path'`)
    const r = record(route, `路由 ${key}`)
    if (!isFunction(r.handler)) fail(`路由 ${key} 没有 handler`)
    if (r.auth !== 'public' && r.auth !== 'user') fail(`路由 ${key} 的 auth 只能是 public 或 user`)
    const auth: 'public' | 'user' = r.auth === 'user' ? 'user' : 'public'
    const permission = r.auth === 'user' && r.permission !== undefined ? r.permission : null
    if (r.auth === 'public' && r.permission !== undefined) fail(`公开路由 ${key} 不能要求权限`)
    if (permission !== null && (typeof permission !== 'string' || !declaredPermissions.has(permission)))
      fail(`路由 ${key} 要求的权限没有在 permissions 里声明`)
    const maxBodyBytes = r.maxBodyBytes ?? DEFAULT_BODY_BYTES
    if (
      typeof maxBodyBytes !== 'number' ||
      !Number.isSafeInteger(maxBodyBytes) ||
      maxBodyBytes < 0 ||
      maxBodyBytes > MAX_BODY_BYTES
    )
      fail(`路由 ${key} 的 maxBodyBytes 必须在 0 到 10 MiB 之间`)
    let rateLimit: PluginContributions['routes'][number]['rateLimit'] = null
    if (r.rateLimit !== undefined) {
      const l = record(r.rateLimit, `路由 ${key} 的 rateLimit`)
      const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      if (!positive(l.limit) || !positive(l.windowSec) || (l.by !== 'ip' && l.by !== 'user'))
        fail(`路由 ${key} 的 rateLimit 格式不对`)
      if (l.by === 'user' && r.auth !== 'user') fail(`公开路由 ${key} 只能按 ip 限流`)
      rateLimit = { limit: l.limit as number, windowSec: l.windowSec as number, by: l.by }
    }
    return {
      method: match[1] as HttpMethod,
      path: match[2]!,
      auth,
      permission: permission,
      maxBodyBytes,
      rateLimit,
    }
  })

  const jobs = Object.entries(record(d.jobs, 'jobs')).map(([name, job]) => {
    if (!KEY.test(name) || name.length > 64) fail(`任务名 ${JSON.stringify(name)} 格式不对`)
    const j = record(job, `任务 ${name}`)
    if (!isFunction(j.handler)) fail(`任务 ${name} 没有 handler`)
    const maxAttempts = j.maxAttempts ?? 5
    const timeoutMs = j.timeoutMs ?? 60_000
    if (typeof maxAttempts !== 'number' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
      fail(`任务 ${name} 的 maxAttempts 必须在 1 到 20 之间`)
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
      fail(`任务 ${name} 的 timeoutMs 必须在 1 到 600000 之间`)
    return { name, maxAttempts, timeoutMs }
  })

  const cronList = d.cron ?? []
  if (!Array.isArray(cronList)) fail('cron 必须是数组')
  const cron = cronList.map((entry, index) => {
    const c = record(entry, `cron[${index}]`)
    if (typeof c.schedule !== 'string' || c.schedule.trim().split(/\s+/).length !== 5)
      fail(`cron[${index}] 的 schedule 必须是五段 cron 表达式`)
    if (typeof c.job !== 'string' || !jobs.some((job) => job.name === c.job))
      fail(`cron[${index}] 的 job 必须是 jobs 里声明的任务`)
    return {
      schedule: c.schedule.trim(),
      job: c.job,
      payload: json((c.payload ?? {}) as Json, `cron[${index}] 的 payload`),
    }
  })

  const ui = json(record(d.ui, 'ui'), 'ui') as PluginContributions['ui']
  validateUi(ui, declaredPermissions)

  return {
    capabilities: [...capabilities] as PluginContributions['capabilities'],
    network: [...(network as string[])],
    settingsSchema,
    permissions,
    tables,
    migrations,
    events,
    interceptors,
    providers: { passwordHasher, login },
    routes,
    jobs,
    cron,
    ui,
  }
}

function validateUi(ui: PluginContributions['ui'], permissions: ReadonlySet<string>) {
  for (const key of Object.keys(ui))
    if (key !== 'nav' && key !== 'pages' && key !== 'formFields') fail(`ui 里没有 ${key} 这一项`)
  const pages = ui.pages ?? {}
  for (const [name, page] of Object.entries(pages)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) fail(`页面名 ${JSON.stringify(name)} 只能用小写字母、数字和连字符`)
    if (page.area !== 'user' && page.area !== 'admin') fail(`页面 ${name} 的 area 只能是 user 或 admin`)
    if (page.permission !== undefined && !permissions.has(page.permission))
      fail(`页面 ${name} 要求的权限没有在 permissions 里声明`)
    const kind = (page.view as { kind?: unknown } | undefined)?.kind
    if (kind !== 'table' && kind !== 'form' && kind !== 'stats' && kind !== 'markdown')
      fail(`页面 ${name} 的视图只能是 table、form、stats、markdown`)
  }
  for (const item of ui.nav ?? []) {
    const page = pages[item.page]
    if (!page) fail(`导航项指向的页面 ${item.page} 不存在`)
    if (page.area !== item.area) fail(`导航项 ${item.page} 的 area 和页面不一致`)
  }
  const names = new Set<string>()
  for (const { form, field } of ui.formFields ?? []) {
    if (form !== 'auth.register') fail(`只有 auth.register 表单能加字段`)
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(field.name) || names.has(field.name))
      fail(`表单字段名 ${JSON.stringify(field.name)} 格式不对或重复`)
    names.add(field.name)
  }
}

export function buildManifest(definition: AnyPluginDefinition, pkg: PluginPackageJson): PluginManifest {
  const field = record(pkg.nextskin, 'package.json 的 nextskin')
  if (typeof field.id !== 'string' || !PLUGIN_ID.test(field.id)) fail('插件 id 只能用小写字母、数字和单个连字符')
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version))
    fail('插件版本必须是 semver')
  return {
    manifestVersion: 1,
    id: field.id,
    version: pkg.version,
    api: `^${PLUGIN_API_VERSION}`,
    requires: { ...(pkg.nextskin.requires ?? {}) },
    conflicts: [...(pkg.nextskin.conflicts ?? [])],
    ...describePlugin(definition),
    entry: { server: null },
    integrity: {},
  }
}
