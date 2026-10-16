import type { Migration } from 'kysely/migration'
import { z } from 'zod'
import type { Capability } from './capabilities'
import type { PluginContext, TableDef, TableMap } from './context'
import type { Json } from './dto'
import type { EventHandler, EventName } from './events'
import type { InterceptorName, InterceptorRegistration } from './interceptors'
import type { Providers } from './providers'
import type { RouteDefinition, RouteKey } from './routes'
import type { MessageKey, UiContributions } from './ui'

export type SettingsSchema = z.ZodObject
export type PermissionMap = Readonly<Record<string, MessageKey>>

type Ctx<C extends readonly Capability[], S extends SettingsSchema, T extends TableMap> = PluginContext<
  C,
  z.output<S>,
  T
>

export interface JobDefinition<Ctx> {
  handler(args: { payload: Json; attempt: number; ctx: Ctx }): Promise<void>
  /** 默认 5 */
  readonly maxAttempts?: number
  /** 默认 60000 */
  readonly timeoutMs?: number
}

/**
 * 插件定义。
 *
 * 所有贡献都写成这个对象上的字段，而不是在运行时调用 `ctx.on(...)` 注册。
 * 原因：构建工具不执行任何业务逻辑就能把整个插件"会做什么"提取成 manifest.json，
 * 安装前就能展示、校验、检测冲突；读代码的人（和 agent）也只需要看一个地方。
 */
export interface PluginDefinition<
  C extends readonly Capability[],
  S extends SettingsSchema,
  T extends TableMap,
  P extends PermissionMap,
> {
  /** 申请的数据访问能力，没有就写 []。见 capabilities.ts。 */
  readonly capabilities: C
  /** 允许 ctx.fetch 访问的 origin */
  readonly network?: readonly `https://${string}`[]
  readonly settings?: S
  /** 插件新增的权限：键是权限名，值是给管理员看的说明文案键 */
  readonly permissions?: P
  readonly tables?: T
  /** Kysely 迁移，按键名排序执行；键名建议 '0001_create_codes' 这种格式 */
  readonly migrations?: Readonly<Record<string, Migration>>

  readonly on?: { readonly [E in EventName]?: EventHandler<E, Ctx<C, S, T>> }
  readonly intercept?: { readonly [I in InterceptorName]?: InterceptorRegistration<I, Ctx<C, S, T>> }
  readonly providers?: Providers<Ctx<C, S, T>>
  readonly routes?: { readonly [K in RouteKey]?: RouteDefinition<Ctx<C, S, T>, P> }
  readonly jobs?: Readonly<Record<string, JobDefinition<Ctx<C, S, T>>>>
  /** schedule 为五段 cron 表达式，按站点时区解释 */
  readonly cron?: readonly { readonly schedule: string; readonly job: string; readonly payload?: Json }[]
  readonly ui?: UiContributions<P>

  /**
   * 逃生舱：只在上面的字段表达不了时使用（例如需要维持一条常驻的出站连接）。
   * 返回的清理函数会在插件停用或换代时调用。
   */
  readonly setup?: (args: { ctx: Ctx<C, S, T> }) => Promise<void | (() => Promise<void>)>
}

export function definePlugin<
  const C extends readonly Capability[],
  S extends SettingsSchema = z.ZodObject<{}>,
  T extends TableMap = {},
  P extends PermissionMap = {},
>(definition: PluginDefinition<C, S, T, P>): PluginDefinition<C, S, T, P> {
  return definition
}

/** 声明一张插件表的行类型，运行时只是一个标记。 */
export function table<Row extends object>(): TableDef<Row> {
  return { kind: 'table' }
}

/** 敏感设置项：加密存储，后台用密码框显示，永远不会回传到浏览器。 */
export function secret() {
  return z.string().min(1).meta({ secret: true })
}
