/**
 * 插件路由网关：`/plugins/{id}/*`（ADR-0033"路由"）。
 *
 * - 登录态只认会话 Cookie（ADR-0022）；带 Cookie 的非 GET 请求校验 Origin。
 * - 请求体按路由声明的上限完整读入后转发；插件拿不到 Cookie。
 * - 插件的响应不能设 Cookie，也不能在站点的源上运行脚本：响应一律加 `Content-Security-Policy: sandbox`。
 */
import { DomainError, type Core, type PluginRouteRequest } from '@nextskin/domain'
import { LOCALE_COOKIE, resolveLocale } from '@nextskin/i18n'
import { BodyTooLargeError, readBody } from '@nextskin/plugin-host'
import type { Context, Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { clientIp } from './client-ip.ts'
import type { AppEnv } from './env.ts'
import { createErrorResponse, logError, restErrorCode } from './rest/errors.ts'
import { createMemoryRateLimiter, type RateLimiter } from './rest/rate-limit.ts'

/** 插件路由响应体的上限（SDK 的 routes.ts） */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** 逐跳的头、由服务器决定的头，以及插件不能设的头 */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'content-length',
  'set-cookie',
  'set-cookie2',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
  'strict-transport-security',
  'clear-site-data',
  'access-control-allow-credentials',
])
const NULL_BODY = new Set([101, 204, 205, 304])

export function registerPluginRoutes(app: Hono<AppEnv>, core: Core) {
  const errorResponse = createErrorResponse(core)
  const limiters = new Map<string, RateLimiter>()

  function limiter(key: string, rule: { limit: number; windowSec: number }) {
    let found = limiters.get(key)
    if (!found) {
      found = createMemoryRateLimiter(Date.now, { limit: rule.limit, windowMs: rule.windowSec * 1000 })
      limiters.set(key, found)
    }
    return found
  }

  app.all('/plugins/:id/*', async (c) => {
    try {
      return await handle(c)
    } catch (error) {
      const code = error instanceof Error ? restErrorCode(error) : 'internal_error'
      if (code === 'internal_error') logError(error)
      if (code === 'too_many_requests' && error instanceof DomainError)
        c.header('Retry-After', String(error.params?.retryAfter ?? 10))
      return error instanceof DomainError ? errorResponse(c, code, error.params, error.fields) : errorResponse(c, code)
    }
  })

  async function handle(c: Context<AppEnv, '/plugins/:id/*'>) {
    const pluginId = c.req.param('id')
    const prefix = `/plugins/${pluginId}`
    // 末尾的斜杠和不带斜杠的相同（Hono 的 strict: false）
    const path = c.req.path.slice(prefix.length).replace(/(?<=.)\/+$/, '') || '/'
    const method = c.req.method === 'HEAD' ? 'GET' : c.req.method
    const route = core.plugins.routeOf(pluginId, method, path)
    if (!route) throw new DomainError('plugin_route_not_found')
    const ip = await clientIp(c, core)
    if (ip === null) throw new DomainError('service_unavailable')

    const sessionUser =
      route.auth === 'user' ? await core.auth.getSessionUser(c.req.raw.headers, c.get('requestRoot')) : null
    if (sessionUser && !SAFE_METHODS.has(c.req.method)) {
      const { 'site.url': siteUrl } = await core.settings.read(['site.url'])
      if (c.req.header('origin') !== new URL(siteUrl || c.get('requestRoot')).origin)
        throw new DomainError('invalid_origin')
    }
    if (route.rateLimit) {
      const by = route.rateLimit.by === 'user' && sessionUser ? `user:${sessionUser.uid}` : `ip:${ip}`
      const result = await limiter(`${pluginId} ${route.method} ${route.path}`, route.rateLimit).consume(by)
      if (!result.allowed) throw new DomainError('too_many_requests', { retryAfter: result.retryAfter })
    }

    if (Number(c.req.header('content-length')) > route.maxBodyBytes) throw new DomainError('request_too_large')
    let body: Uint8Array | null
    try {
      body = SAFE_METHODS.has(c.req.method) ? null : await readBody(c.req.raw.body, route.maxBodyBytes)
    } catch (error) {
      if (error instanceof BodyTooLargeError) throw new DomainError('request_too_large')
      throw error
    }
    const url = new URL(c.req.url)
    const { 'site.locale': siteLocale } = await core.settings.read(['site.locale'])
    const request: PluginRouteRequest = {
      pluginId,
      method,
      path,
      request: {
        method,
        url: `${c.get('requestRoot')}${url.pathname}${url.search}`,
        // 会话 Cookie 不交给插件：登录的是谁，在 scope.actor 里
        headers: [...c.req.raw.headers].filter(([name]) => name !== 'cookie'),
        body: body && body.byteLength ? body : null,
      },
      user: sessionUser ? { uid: sessionUser.uid, role: sessionUser.role } : null,
      ip,
      locale: resolveLocale({
        cookie: getCookie(c, LOCALE_COOKIE),
        acceptLanguage: c.req.header('accept-language'),
        siteDefault: siteLocale,
      }),
    }
    const response = await core.plugins.route(request)
    if (response.body && response.body.byteLength > MAX_RESPONSE_BYTES) throw new DomainError('plugin_error')
    const headers = new Headers()
    for (const [name, value] of response.headers) {
      if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue
      try {
        headers.append(name, value)
      } catch {
        throw new DomainError('plugin_error')
      }
    }
    // 插件返回的 HTML 不能在站点的源上运行脚本、提交表单，也不能被浏览器猜成别的类型
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
    headers.set('X-Content-Type-Options', 'nosniff')
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store')
    return new Response(
      NULL_BODY.has(response.status) || c.req.method === 'HEAD' ? null : (response.body as Uint8Array<ArrayBuffer>),
      { status: response.status, headers },
    )
  }
}
