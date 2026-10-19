/**
 * 核心和插件侧之间传递的消息。插件侧可能在另一个进程里（plugin host），
 * 所以这里的每个值都必须能结构化克隆；官方插件在核心进程内运行时，核心同样把它们克隆一次。
 */
import type {
  CoreInterceptors,
  EventEnvelope,
  EventName,
  HttpMethod,
  InterceptorName,
  Json,
  RequestScope,
} from '@nextskin/plugin-sdk'
import type { PluginContributions } from './manifest.ts'
import type { PluginMessages } from './messages.ts'
import type { CoreDialect } from './remote-dialect.ts'

/** 请求和响应在两边都要完整读入，所以有大小上限（SDK 的 routes.ts） */
export interface SerializedRequest {
  readonly method: string
  readonly url: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body: Uint8Array | null
}

export interface SerializedResponse {
  readonly status: number
  readonly statusText: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body: Uint8Array | null
}

/** 核心发给插件侧的一次调用 */
export type PluginCall =
  | { readonly kind: 'event'; readonly event: EventEnvelope<EventName> }
  | { readonly kind: 'job'; readonly name: string; readonly payload: Json; readonly attempt: number }
  | {
      readonly kind: 'intercept'
      readonly name: InterceptorName
      readonly input: CoreInterceptors[InterceptorName]['input']
      readonly scope: RequestScope
    }
  | {
      readonly kind: 'route'
      readonly method: HttpMethod
      /** 定义里的路径，例如 '/codes/:code' */
      readonly path: string
      readonly params: Readonly<Record<string, string>>
      readonly request: SerializedRequest
      readonly scope: RequestScope
    }
  /** passwordHasher 的 verify；`provider` 是 Provider 的 id。参数里有明文密码，核心不记录调用的内容 */
  | { readonly kind: 'passwordHasher'; readonly provider: string; readonly password: string; readonly hash: string }
  | { readonly kind: 'migrate'; readonly name: string }
  /** 用插件自己的 zod schema 再校验一次设置；不通过时返回出错的顶层键 */
  | { readonly kind: 'validateSettings'; readonly values: Readonly<Record<string, Json>> }

export type InterceptOutcome = null | { readonly action: 'deny'; readonly code: string; readonly message: string }

/** 每次调用都带上的环境：插件侧不缓存这些，管理员改了设置，下一次调用就是新值 */
export interface InvocationContext {
  readonly invocationId: string
  /** 存着的设置值（机密项已解密），按顶层键；没存的项由插件的 schema 补默认值 */
  readonly settings: Readonly<Record<string, Json>>
  readonly site: { readonly url: string; readonly name: string }
  readonly locale: string
  /** 到了就 abort `ctx.signal`；核心那边同样按它放弃这次调用 */
  readonly timeoutMs: number
}

/** 插件侧发给核心的请求。核心按这次调用登记的权限和插件被授予的能力放行 */
export interface CoreRequests {
  'db.query': { args: { node: unknown }; result: { rows: unknown[]; numAffectedRows?: bigint; insertId?: bigint } }
  'kv.get': { args: { key: string }; result: Json | null }
  'kv.set': { args: { key: string; value: Json; ttlSec?: number }; result: null }
  'kv.delete': { args: { key: string }; result: null }
  'jobs.enqueue': {
    args: { name: string; payload: Json; delaySec?: number; dedupeKey?: string }
    result: null
  }
  fetch: { args: SerializedRequest; result: SerializedResponse }
  'users.get': { args: { uid: number }; result: Json | null }
  'users.getMany': { args: { uids: readonly number[] }; result: Json[] }
  'users.findByEmail': { args: { email: string }; result: Json | null }
  'players.get': { args: { pid: number }; result: Json | null }
  'players.findByName': { args: { name: string }; result: Json | null }
  'players.findByUuid': { args: { uuid: string }; result: Json | null }
  'players.listByUser': { args: { uid: number }; result: Json[] }
  'textures.get': { args: { tid: number }; result: Json | null }
  'textures.findByHash': { args: { hash: string }; result: Json | null }
  'textures.files.read': { args: { hash: string }; result: Uint8Array | null }
  log: {
    args: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; fields?: Readonly<Record<string, Json>> }
    result: null
  }
}

export type CoreMethod = keyof CoreRequests

export type CoreRpc = <M extends CoreMethod>(
  invocationId: string,
  method: M,
  args: CoreRequests[M]['args'],
) => Promise<CoreRequests[M]['result']>

/** 跨进程传的错误只有名字、消息和 code：核心按名字区分超时、设置无效这几类，消息只进日志和后台 */
export interface WireError {
  readonly name: string
  readonly message: string
  readonly code?: string
}

/** 交给 plugin host 加载的一个插件 */
export interface HostPluginSpec {
  readonly id: string
  readonly version: string
  /** 插件包解开后的目录（绝对路径）；host 进程只能读这些目录和它自己的代码 */
  readonly dir: string
  /** manifest 的 `entry.server`，相对 dir */
  readonly entry: string
  readonly messages: PluginMessages
}

/**
 * 核心发给 plugin host 的消息（ADR-0009、ADR-0033）。经 host 的 stdin/stdout 传输，格式见 channel.ts。
 * 一个 host 进程就是一代：`init` 只发一次，插件的组合变了就换一个进程
 */
export type CoreToHost =
  | {
      readonly type: 'init'
      readonly dialect: CoreDialect
      readonly fallbackLocale: string
      readonly plugins: readonly HostPluginSpec[]
    }
  | {
      readonly type: 'call'
      readonly id: number
      readonly pluginId: string
      readonly call: PluginCall
      readonly context: InvocationContext
    }
  | { readonly type: 'cancel'; readonly invocationId: string }
  | { readonly type: 'rpcResult'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: 'rpcResult'; readonly id: number; readonly ok: false; readonly error: WireError }

/** `ready` 里每个插件的加载结果：加载成功的报告它实际的定义，核心拿去和 manifest 比对 */
export type HostLoadResult =
  | { readonly id: string; readonly ok: true; readonly contributions: PluginContributions }
  | { readonly id: string; readonly ok: false; readonly error: string }

export type HostToCore =
  | { readonly type: 'ready'; readonly plugins: readonly HostLoadResult[] }
  | { readonly type: 'result'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: 'result'; readonly id: number; readonly ok: false; readonly error: WireError }
  | {
      readonly type: 'rpc'
      readonly id: number
      readonly invocationId: string
      readonly method: CoreMethod
      readonly args: unknown
    }
