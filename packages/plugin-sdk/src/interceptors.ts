import type { Actor, ExtraFields, Player, TextureType, Tid, Uid } from './dto'

/**
 * 拦截器：在操作发生**之前**同步调用，可以拒绝，或修改白名单里的字段。
 *
 * - 只有这里列出的点可以拦截。不存在"拦截任意数据"的通用 filter：
 *   需要新的拦截点就向核心提 issue，由核心决定它的输入、可改字段和失败策略。
 * - 多个插件拦截同一个点时，按 priority 从小到大、再按插件 id 排序依次执行；
 *   任何一个 deny 立即短路；patch 按顺序叠加。每一步都会记录到 trace 中。
 */
export interface CoreInterceptors {
  'user.register': {
    input: {
      email: string
      nickname: string
      /** 注册时顺带创建的角色名；站点关闭该功能时为 null */
      playerName: string | null
      ip: string
      extra: ExtraFields
    }
    patch: { nickname?: string }
  }
  'user.login': {
    input: { uid: Uid; method: 'password' | 'oauth' | 'passkey'; ip: string }
    patch: never
  }
  'player.create': {
    input: { uid: Uid; name: string }
    patch: never
  }
  'player.rename': {
    input: { player: Player; newName: string }
    patch: never
  }
  'texture.upload': {
    input: {
      uid: Uid
      name: string
      type: TextureType
      public: boolean
      width: number
      height: number
      sizeBytes: number
      hash: string
      /** 规范化之后、即将落盘的 PNG */
      png: Uint8Array
    }
    patch: { name?: string; public?: boolean }
  }
  'closet.add': {
    input: { uid: Uid; tid: Tid }
    patch: never
  }
}

export type InterceptorName = keyof CoreInterceptors

export interface InterceptorPolicy {
  /** 插件超时或抛错时怎么办：'closed' 拒绝请求；'open' 当作放行，并记录告警。 */
  readonly onFailure: 'open' | 'closed'
  readonly timeoutMs: number
  /**
   * true：在核心的数据库事务内调用。插件在处理函数里通过 `ctx.db` 做的写入
   * 会随核心事务一起提交或回滚。代价是事务在等待插件期间保持打开，所以超时很短。
   */
  readonly transactional: boolean
}

/** 每个拦截点的失败策略与时间预算由核心规定，属于插件 API 契约的一部分。 */
export const interceptorPolicies = {
  'user.register': { onFailure: 'closed', timeoutMs: 1500, transactional: true },
  'user.login': { onFailure: 'open', timeoutMs: 800, transactional: false },
  'player.create': { onFailure: 'closed', timeoutMs: 1000, transactional: true },
  'player.rename': { onFailure: 'closed', timeoutMs: 1000, transactional: true },
  'texture.upload': { onFailure: 'open', timeoutMs: 5000, transactional: false },
  'closet.add': { onFailure: 'open', timeoutMs: 800, transactional: true },
} as const satisfies Record<InterceptorName, InterceptorPolicy>

export interface Deny {
  readonly action: 'deny'
  /** 机器可读，例如 'invalid_code'；会出现在 API 错误响应里 */
  readonly code: string
  /** 已本地化、给最终用户看的文案 */
  readonly message: string
}

export interface Patch<P> {
  readonly action: 'patch'
  readonly patch: P
}

type PatchOf<I extends InterceptorName> = CoreInterceptors[I]['patch']

export type InterceptResult<I extends InterceptorName> =
  void | Deny | ([PatchOf<I>] extends [never] ? never : Patch<PatchOf<I>>)

export interface RequestScope {
  readonly requestId: string
  readonly actor: Actor
  readonly locale: string
  readonly ip: string
}

export type InterceptorHandler<I extends InterceptorName, Ctx> = (args: {
  readonly input: Readonly<CoreInterceptors[I]['input']>
  readonly scope: RequestScope
  readonly ctx: Ctx
}) => Promise<InterceptResult<I>>

export type InterceptorRegistration<I extends InterceptorName, Ctx> =
  | InterceptorHandler<I, Ctx>
  | {
      readonly handler: InterceptorHandler<I, Ctx>
      /** 默认 100，越小越先执行 */
      readonly priority?: number
      /** 插件可以把失败策略收紧为 closed（例如安全类插件），但不能放宽。 */
      readonly failClosed?: true
    }

export function deny(code: string, message: string): Deny {
  return { action: 'deny', code, message }
}

export function patch<P>(value: P): Patch<P> {
  return { action: 'patch', patch: value }
}
