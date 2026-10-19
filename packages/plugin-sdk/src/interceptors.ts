import type { Actor, ExtraFields } from './dto.ts'

/**
 * 拦截器：在操作发生**之前**同步调用，可以拒绝。
 *
 * - 只有这里列出的点可以拦截。不存在"拦截任意数据"的通用 filter：
 *   需要新的拦截点就向核心提 issue，由核心决定它的输入、可改字段和失败策略。
 * - 多个插件拦截同一个点时，按 priority 从小到大、再按插件 id 排序依次执行；任何一个 deny 立即短路。
 * - 某个插件的同一个拦截器连续失败时，核心在冷却期内不再调用它，直接按失败策略处理。
 */
export interface CoreInterceptors {
  /**
   * 新建用户之前，在注册事务内调用：注册表单，以及第三方登录的首次建号（"完成注册"页）。两者的输入相同，
   * `extra` 是用户在各自页面上填的插件字段。安装向导创建第一个超级管理员、从 BS 导入的用户不经过它。
   * 事务可能整体重跑，拦截器也就可能被调用不止一次；`ctx.db` 的写入会随之回滚，可以安全地再来一次。
   */
  'user.register': {
    input: {
      email: string
      nickname: string
      /** 注册时顺带创建的角色名；站点关闭该功能时为 null */
      playerName: string | null
      ip: string
      extra: ExtraFields
    }
    /** 不能改字段：昵称在事务之前校验，注册时还可能同时建同名角色 */
    patch: never
  }
}

export type InterceptorName = keyof CoreInterceptors

export interface InterceptorPolicy {
  /** 插件超时或抛错时怎么办：'closed' 拒绝请求；'open' 当作放行，并记录告警。 */
  readonly onFailure: 'open' | 'closed'
  /** 四种数据库用同一个预算 */
  readonly timeoutMs: number
  /**
   * true：在核心的数据库事务内调用。插件在处理函数里通过 `ctx.db` 做的写入
   * 会随核心事务一起提交或回滚；上下文收窄成 `TransactionalPluginContext`。
   */
  readonly transactional: boolean
}

/** 每个拦截点的失败策略与时间预算由核心规定，属于插件 API 契约的一部分。 */
export const interceptorPolicies = {
  'user.register': { onFailure: 'closed', timeoutMs: 300, transactional: true },
} as const satisfies Record<InterceptorName, InterceptorPolicy>

export interface Deny {
  readonly action: 'deny'
  /** 机器可读，例如 'invalid_code'；会出现在 API 错误响应里 */
  readonly code: string
  /** 已本地化、给最终用户看的文案 */
  readonly message: string
}

export type InterceptResult = void | Deny

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
}) => Promise<InterceptResult>

export type InterceptorRegistration<I extends InterceptorName, Ctx> =
  | InterceptorHandler<I, Ctx>
  | {
      readonly handler: InterceptorHandler<I, Ctx>
      /** 默认 100，越小越先执行 */
      readonly priority?: number
    }

export function deny(code: string, message: string): Deny {
  return { action: 'deny', code, message }
}
