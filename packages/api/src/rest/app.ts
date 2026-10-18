import { OpenAPIHono } from '@hono/zod-openapi'
import { DomainError, type Core } from '@nextskin/domain'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../env.ts'
import { createErrorResponse, logError, restErrorCode } from './errors.ts'
import { registerCloset } from './closet.ts'
import { registerReports } from './reports.ts'
import { registerPlayers } from './players.ts'
import { registerCheckIn } from './check-in.ts'
import { registerUser } from './user.ts'
import { createMemoryRateLimiter, type RateLimiter } from './rate-limit.ts'
import { registerRegistration } from './register.ts'
import { registerTextures } from './textures.ts'

export function createRestApp(
  core: Core,
  options: { rateLimiter?: RateLimiter; uploadRateLimiter?: RateLimiter } = {},
) {
  const rateLimiter = options.rateLimiter ?? createMemoryRateLimiter()
  const errorResponse = createErrorResponse(core)
  const app = new OpenAPIHono<AppEnv>({
    strict: false,
    defaultHook: (result, c) => {
      if (!result.success) {
        const fields = [
          ...new Set(
            result.error.issues.flatMap((issue) => (typeof issue.path[0] === 'string' ? [issue.path[0]] : [])),
          ),
        ]
        return errorResponse(c, 'invalid_request', undefined, fields)
      }
    },
  })
  app.onError((error, c) => {
    const code = restErrorCode(error)
    if (code === 'internal_error') logError(error)
    if (code === 'too_many_requests' && error instanceof DomainError)
      c.header('Retry-After', String(error.params?.retryAfter ?? 10))
    const respond = createErrorResponse(
      core,
      /\/players(?:\/|$)/.test(c.req.path)
        ? {
            player_name_required: 'name',
            player_name_invalid: 'name',
            player_name_length: 'name',
            player_name_taken: 'name',
          }
        : {},
    )
    return respond(c, code, error instanceof DomainError ? error.params : undefined)
  })
  app.use(
    '*',
    createMiddleware<AppEnv>(async (c, next) => {
      if (c.req.method !== 'POST' || !/\/textures\/?$/.test(c.req.path)) {
        const limit = bodyLimit({ maxSize: 16 * 1024 }) as MiddlewareHandler<AppEnv>
        return limit(c, next)
      }
      const { 'texture.maxFileSizeKb': max } = await core.settings.read(['texture.maxFileSizeKb'])
      c.set('textureMaxKb', max)
      const maxSize = max * 1024 + 64 * 1024
      if (Number(c.req.header('content-length')) > maxSize) throw new DomainError('texture_file_too_large', { max })
      // bodyLimit 会信任 Content-Length；仍逐块计数，挡住伪造的小长度。
      const headers = new Headers(c.req.raw.headers)
      headers.delete('content-length')
      c.req.raw = new Request(c.req.raw, { headers })
      const limit = bodyLimit({
        maxSize,
        onError: () => {
          throw new DomainError('texture_file_too_large', { max })
        },
      }) as MiddlewareHandler<AppEnv>
      return limit(c, next)
    }),
  )
  app.use(
    '*',
    createMiddleware<AppEnv>(async (c, next) => {
      const settings = await core.settings.read(['site.url'])
      const origin = new URL(settings['site.url'] || c.get('requestRoot')).origin
      // 只按站点 Origin 放行，不能让 Sec-Fetch-Site 绕过配置的站点地址。
      const protect = csrf({ origin, secFetchSite: () => false }) as MiddlewareHandler<AppEnv>
      return protect(c, next)
    }),
  )
  app.use(
    '*',
    createMiddleware<AppEnv>(async (c, next) => {
      if (c.req.method === 'POST' && /\/textures\/?$/.test(c.req.path)) {
        if (!/^multipart\/form-data(?:\s*;|$)/i.test(c.req.header('content-type') ?? ''))
          return errorResponse(c, 'invalid_request', undefined, undefined, 415)
        return next()
      }
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
        !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '') &&
        c.req.raw.body !== null &&
        (await c.req.raw.clone().arrayBuffer()).byteLength > 0
      )
        return errorResponse(c, 'invalid_request', undefined, undefined, 415)
      await next()
    }),
  )
  registerTextures(
    app,
    core,
    options.uploadRateLimiter ?? createMemoryRateLimiter(Date.now, { limit: 10, windowMs: 60_000 }),
  )
  registerRegistration(app, core)
  registerCloset(app, core)
  registerReports(app, core)
  registerPlayers(app, core)
  registerCheckIn(app, core)
  registerUser(app, core, rateLimiter)
  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'NextSkin REST API', version: '1.0.0' },
    servers: [{ url: '/api' }],
  })
  return app
}
