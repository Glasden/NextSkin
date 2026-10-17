import { OpenAPIHono } from '@hono/zod-openapi'
import { DomainError, type Core } from '@nextskin/domain'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../env.ts'
import { createErrorResponse, logError, restErrorCode } from './errors.ts'
import { registerRegistration } from './register.ts'

export function createRestApp(core: Core) {
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
    return errorResponse(c, code, error instanceof DomainError ? error.params : undefined)
  })
  app.use('*', bodyLimit({ maxSize: 16 * 1024 }))
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
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
        !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')
      )
        return errorResponse(c, 'invalid_request', undefined, undefined, 415)
      await next()
    }),
  )
  registerRegistration(app, core)
  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'NextSkin REST API', version: '1.0.0' },
    servers: [{ url: '/api' }],
  })
  return app
}
