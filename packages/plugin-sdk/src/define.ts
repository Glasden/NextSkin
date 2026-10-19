import { z } from 'zod'
import type { Capability } from './capabilities.ts'
import type { PluginContext, PluginMigration, TableDef, TableMap, TransactionalPluginContext } from './context.ts'
import type { Json } from './dto.ts'
import type { EventHandler, EventName } from './events.ts'
import type { InterceptorName, InterceptorRegistration, interceptorPolicies } from './interceptors.ts'
import type { Providers } from './providers.ts'
import type { RouteDefinition, RouteKey } from './routes.ts'
import type { MessageKey, UiContributions } from './ui.ts'

export type SettingsSchema = z.ZodObject
export type PermissionMap = Readonly<Record<string, MessageKey>>

type Ctx<C extends readonly Capability[], S extends SettingsSchema, T extends TableMap> = PluginContext<
  C,
  z.output<S>,
  T
>

/** 拦截器的上下文按 `interceptorPolicies` 收窄：事务内的拦截器只有 `db` 和不用等核心回应的几项。 */
type InterceptorCtx<
  I extends InterceptorName,
  C extends readonly Capability[],
  S extends SettingsSchema,
  T extends TableMap,
> = (typeof interceptorPolicies)[I]['transactional'] extends true
  ? TransactionalPluginContext<C, z.output<S>, T>
  : Ctx<C, S, T>

export interface JobDefinition<Ctx> {
  handler(args: { payload: Json; attempt: number; ctx: Ctx }): Promise<void>
  /** 整数 1–20，默认 5 */
  readonly maxAttempts?: number
  /** 整数 1–600000 毫秒，默认 60000 */
  readonly timeoutMs?: number
}

/**
 * 插件定义。
 *
 * 所有贡献都写成这个对象上的字段，而不是在运行时调用 `ctx.on(...)` 注册。
 * 原因：构建工具不调用 handler 就能把整个插件"会做什么"提取成 manifest.json，
 * 构建会执行入口模块的顶层代码。安装前就能展示、校验、检测冲突；读代码的人（和 agent）也只需要看一个地方。
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
  /** 设置校验调用限 5 秒；支持字符串、数字、布尔、字符串枚举和一层对象，机密只能在顶层。 */
  readonly settings?: S
  /** 插件新增的权限：键为 `[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*`，值是说明文案键 */
  readonly permissions?: P
  readonly tables?: T
  /**
   * 迁移名为 `[A-Za-z0-9_-]{1,128}`，需申请 storage.tables。按键名排序执行，键名建议 '0001_create_codes' 这种格式。启用插件之前由核心执行，只往前走。
   * DDL 只能写在这里；表名写逻辑名，并且必须在 `tables` 里声明。
   */
  readonly migrations?: Readonly<Record<string, PluginMigration>>

  readonly on?: { readonly [E in EventName]?: EventHandler<E, Ctx<C, S, T>> }
  readonly intercept?: {
    readonly [I in InterceptorName]?: InterceptorRegistration<I, InterceptorCtx<I, C, S, T>>
  }
  readonly providers?: Providers<Ctx<C, S, T>>
  readonly routes?: { readonly [K in RouteKey]?: RouteDefinition<Ctx<C, S, T>, P> }
  /** 名为 `[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*`，最多 64 字符；加 plugin:<id>:job: 后不超过 128 字符。 */
  readonly jobs?: Readonly<Record<string, JobDefinition<Ctx<C, S, T>>>>
  /**
   * schedule 为五段 cron 表达式，按站点时区解释；日和星期两段都限定时取"或"，任一满足就执行。
   * 停机期间错过的多次执行只补一次；到时上一次还没执行完，这一次跳过。
   * 夏令时拨快跳过的时刻顺延到跳过之后执行一次，拨慢重复的时刻只在第一次执行（ADR-0029）。
   */
  readonly cron?: readonly { readonly schedule: string; readonly job: string; readonly payload?: Json }[]
  readonly ui?: UiContributions<P>
}

/* eslint-disable @typescript-eslint/no-empty-object-type -- 这里的 {} 表示"一项都没有声明" */
export function definePlugin<
  const C extends readonly Capability[],
  S extends SettingsSchema = z.ZodObject<{}>,
  T extends TableMap = {},
  P extends PermissionMap = {},
>(definition: PluginDefinition<C, S, T, P>): PluginDefinition<C, S, T, P> {
  return definition
}
/* eslint-enable @typescript-eslint/no-empty-object-type */

/** 声明一张插件表的行类型，运行时只是一个标记。 */
export function table<Row extends object>(): TableDef<Row> {
  return { kind: 'table' }
}

/**
 * 敏感设置项，只能放在 settings 顶层：加密存储，后台用密码框显示，永远不会回传到浏览器。
 * 在 manifest 的 JSON Schema 里标成 `writeOnly`，和核心的机密设置项是同一个标记（ADR-0028）。
 */
export function secret() {
  return z.string().min(1).meta({ writeOnly: true })
}
