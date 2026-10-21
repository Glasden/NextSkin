import type { Actor, ExtraFields, Uid } from './dto.ts'

/** 用户本人的受限操作；次版本可能加成员。 */
export type UserAction =
  /** 添加角色 */
  | 'player.create'
  /** 改名、换材质或清材质，包括启动器上传和重置材质 */
  | 'player.update'
  /** 删除角色 */
  | 'player.delete'
  /** 上传材质，包括启动器上传 */
  | 'texture.upload'
  /** 改材质的名字、类型、公开状态或描述 */
  | 'texture.update'
  /** 删除材质 */
  | 'texture.delete'
  /** 举报材质 */
  | 'report.create'
  /** 创建自己的 OAuth 应用 */
  | 'oauthClient.create'
  /** 修改自己的 OAuth 应用 */
  | 'oauthClient.update'
  /** 重置自己的 OAuth 应用密钥 */
  | 'oauthClient.resetSecret'
  /** 删除自己的 OAuth 应用 */
  | 'oauthClient.delete'
  | (string & {})

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
  /** 用户本人管理角色、材质、OAuth 应用或举报之前，在事务外调用；封禁的用户不调用。只能拒绝，失败时拒绝。 */
  'user.action': {
    input: { uid: Uid; action: UserAction }
    patch: never
  }
  /**
   * 签发能进服的令牌之前，在事务外调用：启动器密码登录、启动器刷新，以及 Connect 令牌端点带 Join 的签发。
   * authenticate 在密码、封禁、邮箱验证和 clientToken 检查通过后调用；refresh 在令牌、封禁和角色归属检查后调用。
   * 不经过 validate、join、hasJoined、invalidate、signout，也不拦网页登录、第三方登录或通行密钥。
   * 上下文是按能力提供的完整 ctx；失败时拒绝。启动器显示 deny 的 message，Connect 返回 invalid_grant。
   * 已签发的令牌在有效期内仍可进服。
   */
  'yggdrasil.issueToken': {
    input: {
      uid: Uid
      /** authenticate：启动器密码登录；refresh：启动器刷新；oauth：Connect 令牌端点。次版本可能加成员 */
      via: 'authenticate' | 'refresh' | 'oauth' | (string & {})
    }
    /** 只能拒绝，不能修改令牌或输入 */
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
  'user.action': { onFailure: 'closed', timeoutMs: 2000, transactional: false },
  'user.register': { onFailure: 'closed', timeoutMs: 300, transactional: true },
  'yggdrasil.issueToken': { onFailure: 'closed', timeoutMs: 2000, transactional: false },
} as const satisfies Record<InterceptorName, InterceptorPolicy>

export interface Deny {
  readonly action: 'deny'
  /** 机器可读，例如 'invalid_code'；截到 64 字符后出现在 API 错误响应里 */
  readonly code: string
  /** 已本地化、给最终用户看的文案，截到 200 字符 */
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
