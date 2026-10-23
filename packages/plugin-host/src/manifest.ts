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
import sdkPackage from '@nextskin/plugin-sdk/package.json' with { type: 'json' }
import { checkTheme, normalizeThemeColors, pluginThemesError, resolveTheme, type ThemeIssue } from '@nextskin/theme'
import { z } from 'zod'
import { eventNames } from './events.ts'
import { isValidVersion, parseVersion } from './package/semver.ts'
import { settingProperties } from './settings.ts'
import { MAX_WIDGETS_PER_SLOT, pluginFieldSchema, pluginPathSchema, widgetSlots } from './ui-schema.ts'

/**
 * 核心实现的插件 API 版本，就是同一个提交里 SDK 的版本号（ADR-0035）。manifest 的 `api` 范围必须包含它
 */
export const PLUGIN_API_VERSION: string = sdkPackage.version

/**
 * 用某个版本的 SDK 构建的插件，manifest 里的 `api` 写什么（ADR-0035）：取到次版本，
 * 补丁版本不加东西，用 1.3.2 构建的插件在实现 1.3.0 的核心上也能装；预发布版本取完整的版本号
 */
export function pluginApiRange(sdkVersion: string): string {
  const version = parseVersion(sdkVersion)
  if (!version) throw new Error(`SDK 的版本号不是合法的 semver：${sdkVersion}`)
  return version.prerelease.length ? `^${sdkVersion}` : `^${version.major}.${version.minor}.0`
}

// 运行时按形状检查，类型参数取最宽的：具体插件的处理函数参数比这里窄，泛型位置上没有别的写法
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginDefinition = PluginDefinition<any, any, any, any>

/** manifest 里由定义决定的部分；health check 比对的就是它 */
export type PluginContributions = Omit<
  PluginManifest,
  'manifestVersion' | 'id' | 'version' | 'api' | 'requires' | 'conflicts' | 'entry' | 'integrity'
>

/** 核心进程内的官方插件没有打包入口。 */
export type ExtractedPluginManifest = Omit<PluginManifest, 'entry'> & {
  readonly entry: { readonly server: string | null }
}

export interface PluginPackageJson {
  readonly name: string
  readonly version: string
  readonly nextskin: PluginPackageField
}

export const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** 表名、索引名：拼进物理名 `p_<id>__<名字>`，不允许连续下划线（S5） */
export const OBJECT_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
/** login Provider 的 id 进绑定的键，限长（ADR-0034） */
export const MAX_LOGIN_ID_LENGTH = 64
export const KEY = /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/
export const ROUTE_KEY =
  /^(GET|POST|PUT|PATCH|DELETE) (\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*))*|\/)$/
const DEFAULT_BODY_BYTES = 1024 * 1024
export const MAX_BODY_BYTES = 10 * 1024 * 1024

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

  settingProperties({ id: '(构建)', settingsSchema })

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
      } as PluginContributions['providers']['passwordHasher'][number]['detect'],
    }
  })
  const login = list(providers.login, 'login').map((p) => {
    if (!isFunction(p.authorizeUrl) || !isFunction(p.exchange)) fail(`login ${p.id} 要有 authorizeUrl 和 exchange`)
    // 绑定按 `plugin:<插件 id>:<Provider id>` 记录（ADR-0034）
    if (p.id.length > MAX_LOGIN_ID_LENGTH) fail(`login 的 id 不能超过 ${MAX_LOGIN_ID_LENGTH} 个字符`)
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
      payload: json((c.payload === undefined ? {} : c.payload) as Json, `cron[${index}] 的 payload`),
    }
  })

  const ui = json(record(d.ui, 'ui'), 'ui') as PluginContributions['ui']
  validateUi(ui, declaredPermissions)
  const normalizedUi = ui.themes
    ? { ...ui, themes: ui.themes.map((theme) => ({ ...theme, colors: normalizeThemeColors(theme.colors) })) }
    : ui

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
    ui: normalizedUi as PluginContributions['ui'],
  }
}

export function validateUi(ui: PluginContributions['ui'], permissions: ReadonlySet<string>) {
  for (const key of Object.keys(ui))
    if (key !== 'nav' && key !== 'pages' && key !== 'formFields' && key !== 'themes' && key !== 'widgets')
      fail(`ui 里没有 ${key} 这一项`)
  if (ui.themes !== undefined) {
    const error = pluginThemesError(ui.themes)
    if (error) fail(`ui.themes：${error}`)
  }
  const checkField = (field: unknown) => {
    const result = pluginFieldSchema.safeParse(field)
    if (!result.success) fail('UI 字段的类型、选项或属性不匹配')
  }
  const checkPath = (path: unknown, what = 'UI') => {
    if (!pluginPathSchema.safeParse(path).success) fail(`${what} 路径不能有 .、..、空段、反斜杠或 #`)
  }
  const checkAction = (action: { route: string; form?: readonly unknown[] }) => {
    checkPath(action.route)
    for (const field of action.form ?? []) checkField(field)
  }
  const pages = ui.pages ?? {}
  for (const [name, page] of Object.entries(pages)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) fail(`页面名 ${JSON.stringify(name)} 只能用小写字母、数字和连字符`)
    if (page.area !== 'user' && page.area !== 'admin') fail(`页面 ${name} 的 area 只能是 user 或 admin`)
    if (page.permission !== undefined && !permissions.has(page.permission))
      fail(`页面 ${name} 要求的权限没有在 permissions 里声明`)
    const kind = (page.view as { kind?: unknown } | undefined)?.kind
    if (kind !== 'table' && kind !== 'form' && kind !== 'stats' && kind !== 'markdown')
      fail(`页面 ${name} 的视图只能是 table、form、stats、markdown`)
    const view = page.view
    if (view.kind === 'form') {
      for (const field of view.fields) checkField(field)
      if (view.load !== undefined) checkPath(view.load)
      checkPath(view.submit.route)
    } else {
      checkPath(view.source)
      if (view.kind === 'table') {
        for (const action of [...(view.toolbar ?? []), ...(view.rowActions ?? [])]) checkAction(action)
      }
    }
  }
  if (ui.widgets !== undefined && !Array.isArray(ui.widgets)) fail('ui.widgets 必须是数组')
  const widgetNames = new Set<string>()
  const slotCounts = new Map<string, number>()
  for (const item of ui.widgets ?? []) {
    const widget = record(item, '挂件')
    const name = widget.name
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name))
      fail(`挂件名 ${JSON.stringify(name)} 只能用小写字母、数字和连字符，最多 64 个字符`)
    if (widgetNames.has(name)) fail(`挂件 ${name} 的名字重复`)
    widgetNames.add(name)
    for (const key of Object.keys(widget))
      if (!['name', 'slot', 'title', 'permission', 'link', 'view'].includes(key))
        fail(`挂件 ${name} 里没有 ${key} 这一项`)
    if (typeof widget.slot !== 'string' || !Object.hasOwn(widgetSlots, widget.slot))
      fail(`挂件 ${name} 的 slot 只能是 ${Object.keys(widgetSlots).join('、')}`)
    const slot = widget.slot as keyof typeof widgetSlots
    const count = (slotCounts.get(slot) ?? 0) + 1
    if (count > MAX_WIDGETS_PER_SLOT) fail(`挂件 ${name} 所在的插槽 ${slot} 最多放 ${MAX_WIDGETS_PER_SLOT} 个挂件`)
    slotCounts.set(slot, count)
    if (typeof widget.title !== 'string') fail(`挂件 ${name} 的 title 必须是文案键`)
    if (
      widget.permission !== undefined &&
      (typeof widget.permission !== 'string' || !permissions.has(widget.permission))
    )
      fail(`挂件 ${name} 要求的权限没有在 permissions 里声明`)
    const view = record(widget.view, `挂件 ${name} 的 view`)
    if (view.kind !== 'stats' && view.kind !== 'markdown') fail(`挂件 ${name} 的视图只能是 stats、markdown`)
    for (const key of Object.keys(view))
      if (key !== 'kind' && key !== 'source') fail(`挂件 ${name} 的 view 里没有 ${key} 这一项`)
    checkPath(view.source, `挂件 ${name}`)
    if (widget.link !== undefined) {
      const link = record(widget.link, `挂件 ${name} 的 link`)
      for (const key of Object.keys(link))
        if (key !== 'page' && key !== 'label') fail(`挂件 ${name} 的 link 里没有 ${key} 这一项`)
      if (typeof link.page !== 'string' || !Object.hasOwn(pages, link.page))
        fail(`挂件 ${name} 链接的页面 ${String(link.page)} 不存在`)
      if (pages[link.page]!.area !== widgetSlots[slot]) fail(`挂件 ${name} 的插槽和链接页面的 area 不一致`)
      if (typeof link.label !== 'string') fail(`挂件 ${name} 的 link.label 必须是文案键`)
    }
  }
  for (const item of ui.nav ?? []) {
    const page = pages[item.page]
    if (!page) fail(`导航项指向的页面 ${item.page} 不存在`)
    if (page.area !== item.area) fail(`导航项 ${item.page} 的 area 和页面不一致`)
  }
  const names = new Set<string>()
  for (const item of ui.formFields ?? []) {
    for (const key of Object.keys(item))
      if (!['form', 'field', 'fromQuery'].includes(key)) fail(`formFields 条目里没有 ${key} 这一项`)
    const { form, field, fromQuery } = item
    if (fromQuery !== undefined && typeof fromQuery !== 'boolean') fail('fromQuery 必须是布尔值')
    if (fromQuery === true && !['text', 'textarea', 'number', 'select'].includes(field.type))
      fail('fromQuery 只允许 text、textarea、number、select 字段')
    if (form !== 'auth.register') fail(`只有 auth.register 表单能加字段`)
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(field.name) || names.has(field.name))
      fail(`表单字段名 ${JSON.stringify(field.name)} 格式不对或重复`)
    checkField(field)
    names.add(field.name)
  }
}

/** 只列出未通过检查的主题；加载时由核心单独禁用这些主题，不影响插件其他功能。 */
export function pluginThemeIssues(manifest: Pick<PluginContributions, 'ui'>): { name: string; issues: ThemeIssue[] }[] {
  return (manifest.ui.themes ?? []).flatMap(({ name, colors }) => {
    const issues = checkTheme(resolveTheme(colors))
    return issues.length ? [{ name, issues }] : []
  })
}

export function buildManifest(definition: AnyPluginDefinition, pkg: PluginPackageJson): ExtractedPluginManifest {
  const field = record(pkg.nextskin, 'package.json 的 nextskin')
  if (typeof field.id !== 'string' || !PLUGIN_ID.test(field.id)) fail('插件 id 只能用小写字母、数字和单个连字符')
  if (typeof pkg.version !== 'string' || !isValidVersion(pkg.version)) fail('插件版本必须是 semver')
  const contributions = describePlugin(definition)
  for (const job of contributions.jobs) {
    if (`plugin:${field.id}:job:${job.name}`.length > 128) fail('完整任务名不能超过 128 个字符')
  }
  return {
    manifestVersion: 1,
    id: field.id,
    version: pkg.version,
    api: pluginApiRange(PLUGIN_API_VERSION),
    requires: { ...(pkg.nextskin.requires ?? {}) },
    conflicts: [...(pkg.nextskin.conflicts ?? [])],
    ...contributions,
    entry: { server: null },
    integrity: {},
  }
}
