import type { RequestScope } from './interceptors.ts'
import type { UserActor } from './dto.ts'

/**
 * 插件 HTTP 路由，统一挂在 `/plugins/{id}/` 下。
 *
 * 键的格式是 'METHOD /path'，路径参数写 `:name`，例如 'DELETE /codes/:code'。
 * 核心统一处理：登录态（只认会话 Cookie）、权限、CSRF（非 GET 请求校验 Origin）、限流、请求体大小。
 * 请求体完整读入后才交给插件，所以有大小上限；响应体同样完整读出，不超过 10 MiB，不支持流式响应。
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type RouteKey = `${HttpMethod} /${string}`

interface RouteOptions {
  readonly rateLimit?: { readonly limit: number; readonly windowSec: number; readonly by: 'ip' | 'user' }
  /** 默认 1 MiB，最大 10 MiB */
  readonly maxBodyBytes?: number
}

interface RouteArgs<Ctx, Scope> {
  readonly request: Request
  readonly params: Readonly<Record<string, string>>
  readonly scope: Scope
  readonly ctx: Ctx
}

export type RouteDefinition<Ctx, P> =
  | (RouteOptions & {
      readonly auth: 'public'
      handler(args: RouteArgs<Ctx, RequestScope>): Promise<Response>
    })
  | (RouteOptions & {
      readonly auth: 'user'
      /** 有值时还要求当前用户拥有该插件权限（管理员默认拥有全部插件权限） */
      readonly permission?: NoInfer<keyof P & string>
      handler(args: RouteArgs<Ctx, RequestScope & { readonly actor: UserActor }>): Promise<Response>
    })
