import type { RequestScope } from './interceptors.ts'
import type { Actor, UserActor } from './dto.ts'

/**
 * 插件 HTTP 路由，统一挂在 `/plugins/{id}/` 下。
 *
 * 键的格式是 'METHOD /path'，路径参数写 `:name`，例如 'DELETE /codes/:code'。
 * 参数名为 `[A-Za-z][A-Za-z0-9]*`；固定段为 `[A-Za-z0-9._~-]+`，不接受末尾斜杠（根路径除外）。
 * 每次调用限 30 秒；public 路由一律匿名，scope.actor 为 system。
 * 核心统一处理：登录态（只认会话 Cookie）、权限、CSRF（带着会话的非 GET 请求校验 Origin；public 路由不认会话，不检查）、
 * 限流、请求体大小。
 * 请求体完整读入后才交给插件，所以有大小上限；响应体同样完整读出，不超过 10 MiB，不支持流式响应。
 * 交给插件的请求里没有 Cookie、Authorization、Proxy-Authorization：登录的是谁看 scope.actor，
 * 插件要自己的令牌认证就用自己的请求头。响应不能设置 Cookie，CSP 由核心决定；
 * `auth: 'user'` 的路由一律 `Cache-Control: no-store`，公开的路由可以自己设缓存，不设就是 no-store。
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type RouteKey = `${HttpMethod} /${string}`

interface RouteOptions<By extends 'ip' | 'user'> {
  readonly rateLimit?: { readonly limit: number; readonly windowSec: number; readonly by: By }
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
  | (RouteOptions<'ip'> & {
      readonly auth: 'public'
      handler(
        args: RouteArgs<Ctx, RequestScope & { readonly actor: Extract<Actor, { kind: 'system' }> }>,
      ): Promise<Response>
    })
  | (RouteOptions<'ip' | 'user'> & {
      readonly auth: 'user'
      /** 有值时还要求当前用户拥有该插件权限（管理员默认拥有全部插件权限） */
      readonly permission?: NoInfer<keyof P & string>
      handler(args: RouteArgs<Ctx, RequestScope & { readonly actor: UserActor }>): Promise<Response>
    })
