import { capabilities, interceptorPolicies, type PluginManifest } from '@nextskin/plugin-sdk'
import { z } from 'zod'
import { eventNames } from '../events.ts'
import { KEY, MAX_BODY_BYTES, MAX_LOGIN_ID_LENGTH, OBJECT_NAME, PLUGIN_ID, ROUTE_KEY, validateUi } from '../manifest.ts'
import { settingProperties } from '../settings.ts'
import { pluginFieldSchema, pluginPathSchema } from '../ui-schema.ts'
import { PluginPackageError } from './error.ts'
import { isValidRange, isValidVersion } from './semver.ts'

const matching = (pattern: RegExp) => z.string().refine((value) => pattern.exec(value)?.[0] === value, '格式不对')
const key = matching(KEY)
const pluginId = matching(PLUGIN_ID).max(64)
const range = z.string().refine(isValidRange, '版本范围格式不对')
const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const positive = integer.min(1)
const jsonObject = z.record(z.string(), z.json())
const path = pluginPathSchema
const field = pluginFieldSchema
const area = z.enum(['user', 'admin'])
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length
const action = z.strictObject({
  label: z.string(),
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
  route: path,
  tone: z.enum(['default', 'danger']).optional(),
  confirm: z.string().optional(),
  form: z.array(field).optional(),
})
const view = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('table'),
    source: path,
    columns: z.array(
      z.strictObject({
        key: z.string(),
        label: z.string(),
        format: z
          .enum(['text', 'code', 'number', 'datetime', 'boolean', 'status', 'user', 'player', 'texture'])
          .optional(),
      }),
    ),
    searchable: z.boolean().optional(),
    toolbar: z.array(action).optional(),
    rowActions: z.array(action).optional(),
  }),
  z.strictObject({
    kind: z.literal('form'),
    fields: z.array(field),
    load: path.optional(),
    submit: z.strictObject({ route: path, method: z.enum(['POST', 'PUT', 'PATCH']), label: z.string() }),
  }),
  z.strictObject({ kind: z.literal('stats'), source: path }),
  z.strictObject({ kind: z.literal('markdown'), source: path }),
])
const ui = z.strictObject({
  nav: z.array(z.strictObject({ area, page: z.string(), label: z.string(), icon: z.string() })).optional(),
  pages: z
    .record(
      matching(/^[a-z][a-z0-9-]{0,63}$/),
      z.strictObject({ area, title: z.string(), permission: z.string().optional(), view }),
    )
    .optional(),
  formFields: z
    .array(
      z.strictObject({
        form: z.literal('auth.register'),
        field,
        // 只允许哪几种字段由 validateUi 检查
        fromQuery: z.boolean().optional(),
      }),
    )
    .optional(),
})

const schema = z.strictObject({
  manifestVersion: z.literal(1),
  id: pluginId,
  version: z.string().max(64).refine(isValidVersion, '版本格式不对'),
  api: range,
  requires: z.record(pluginId, range),
  conflicts: z.array(pluginId).refine(unique, '不能重复'),
  capabilities: z.array(z.enum(capabilities)).refine(unique, '不能重复'),
  network: z.array(
    z.string().refine((origin) => {
      try {
        const url = new URL(origin)
        return url.protocol === 'https:' && url.origin === origin
      } catch {
        return false
      }
    }, '必须是 https 的 origin'),
  ),
  settingsSchema: jsonObject.nullable(),
  permissions: z.record(key, z.string()),
  tables: z.array(matching(OBJECT_NAME)).refine(unique, '不能重复'),
  migrations: z
    .array(matching(/^[A-Za-z0-9_-]{1,128}$/))
    .refine((items) => unique(items) && items.every((v, i) => i === 0 || items[i - 1]! < v), '必须排序且不重复'),
  events: z.array(z.enum(eventNames)).refine(unique, '不能重复'),
  interceptors: z
    .array(
      z.strictObject({
        name: z.string().refine((name) => Object.hasOwn(interceptorPolicies, name), '未知的拦截点'),
        priority: integer,
      }),
    )
    .refine((items) => unique(items.map((item) => item.name)), '拦截点不能重复'),
  providers: z.strictObject({
    passwordHasher: z
      .array(
        z.strictObject({
          id: key,
          label: z.string(),
          detect: z
            .strictObject({
              prefix: z.array(z.string().min(1)).optional(),
              pattern: z
                .string()
                .refine((pattern) => {
                  try {
                    new RegExp(pattern, 'u')
                    return true
                  } catch {
                    return false
                  }
                }, '正则格式不对')
                .optional(),
            })
            .refine(
              (detect) => detect.prefix !== undefined || detect.pattern !== undefined,
              '至少声明 prefix 或 pattern',
            ),
        }),
      )
      .refine((items) => unique(items.map((item) => item.id)), 'id 不能重复'),
    login: z
      .array(z.strictObject({ id: key.max(MAX_LOGIN_ID_LENGTH), label: z.string(), icon: z.string() }))
      .refine((items) => unique(items.map((item) => item.id)), 'id 不能重复'),
  }),
  routes: z
    .array(
      z.strictObject({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string(),
        auth: z.enum(['public', 'user']),
        permission: z.string().nullable(),
        maxBodyBytes: integer.min(0).max(MAX_BODY_BYTES),
        rateLimit: z.strictObject({ limit: positive, windowSec: positive, by: z.enum(['ip', 'user']) }).nullable(),
      }),
    )
    .refine((items) => unique(items.map((item) => `${item.method} ${item.path}`)), '路由不能重复'),
  jobs: z
    .array(z.strictObject({ name: key.max(64), maxAttempts: positive.max(20), timeoutMs: positive.max(600_000) }))
    .refine((items) => unique(items.map((item) => item.name)), '任务名不能重复'),
  cron: z.array(
    z.strictObject({
      schedule: z.string().refine((s) => s.trim().split(/\s+/).length === 5, '必须是五段 cron 表达式'),
      job: z.string(),
      payload: z.json(),
    }),
  ),
  ui,
  entry: z.strictObject({ server: z.string() }),
  integrity: z.record(z.string(), matching(/^[0-9a-f]{64}$/)),
})

/** 只读 JSON，不执行插件代码；严格检查所有对象的键和跨字段引用。 */
export function parsePluginManifest(json: unknown): PluginManifest {
  let parsed: ReturnType<typeof schema.safeParse>
  try {
    parsed = schema.safeParse(json)
  } catch {
    throw new PluginPackageError('invalid_manifest', 'manifest 的 JSON 结构无法校验，可能存在过深嵌套或循环引用')
  }
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    const fields = issue.code === 'unrecognized_keys' ? `.${issue.keys.join(',')}` : ''
    throw new PluginPackageError(
      'invalid_manifest',
      `manifest 的 ${issue.path.join('.') || '根对象'}${fields} 字段格式不对：${issue.code === 'custom' ? issue.message : '类型、取值或声明格式不符合要求'}`,
    )
  }
  const manifest = parsed.data as PluginManifest
  const fail = (field: string, message: string): never => {
    throw new PluginPackageError('invalid_manifest', `manifest 的 ${field}：${message}`)
  }
  if (manifest.migrations.length && !manifest.capabilities.includes('storage.tables'))
    fail('migrations', '必须申请 storage.tables')
  for (const [i, route] of manifest.routes.entries()) {
    if (ROUTE_KEY.exec(`${route.method} ${route.path}`)?.[0] !== `${route.method} ${route.path}`)
      fail(`routes.${i}.path`, '路由格式不对')
    if (route.permission !== null && (route.auth !== 'user' || !Object.hasOwn(manifest.permissions, route.permission)))
      fail(`routes.${i}.permission`, '权限必须在 permissions 里声明，且路由必须要求登录')
    if (route.rateLimit?.by === 'user' && route.auth !== 'user') fail(`routes.${i}.rateLimit`, '公开路由只能按 ip 限流')
  }
  for (const job of manifest.jobs) {
    if (`plugin:${manifest.id}:job:${job.name}`.length > 128) fail('jobs', '完整任务名不能超过 128 个字符')
  }
  for (const [i, cron] of manifest.cron.entries()) {
    if (!manifest.jobs.some((job) => job.name === cron.job)) fail(`cron.${i}.job`, '必须引用 jobs 里声明的任务')
  }
  try {
    settingProperties(manifest)
  } catch (error) {
    fail('settingsSchema', error instanceof Error ? error.message : '声明不合法')
  }
  try {
    validateUi(manifest.ui, new Set(Object.keys(manifest.permissions)))
  } catch (error) {
    fail('ui', error instanceof Error ? error.message : '声明不合法')
  }
  return manifest
}
