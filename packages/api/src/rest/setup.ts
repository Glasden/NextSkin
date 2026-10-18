import { createMiddleware } from 'hono/factory'
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { DomainError, type Core } from '@nextskin/domain'
import { LOCALE_COOKIE, matchAcceptLanguage, matchLocale } from '@nextskin/i18n'
import { getCookie } from 'hono/cookie'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import type { ImportGateway } from '../import-gateway.ts'
import { logError } from './errors.ts'
import {
  envSchema,
  importErrors,
  jsonBody,
  jsonResult,
  setImportCookie,
  sourceSchema,
  startSchema,
} from './import-shared.ts'
import { createMemoryRateLimiter } from './rate-limit.ts'

export function registerSetup(app: OpenAPIHono<AppEnv>, core: Core, importer?: ImportGateway) {
  const limiter = createMemoryRateLimiter(Date.now, { limit: 10, windowMs: 60000 })
  app.use(
    '/setup/*',
    createMiddleware<AppEnv>(async (c, next) => {
      if (await core.setup.isInitialized()) throw new DomainError('setup_completed')
      if (
        c.req.path.replace(/\/+$/, '') !== '/api/setup/code' &&
        !(await core.setup.verifySession(getCookie(c, 'nextskin-setup') ?? ''))
      )
        throw new DomainError('setup_code_required')
      await next()
    }),
  )
  app.use('/setup', () => {
    throw new DomainError('setup_completed')
  })
  app.openapi(
    createRoute({
      method: 'post',
      path: '/setup/code',
      request: { body: jsonBody(z.object({ code: z.string().max(256) })) },
      responses: { 204: { description: '安装码已验证' }, ...importErrors },
    }),
    async (c) => {
      const ip = await clientIp(c, core)
      const result = limiter.consume(ip ?? 'unknown')
      if (!result.allowed) throw new DomainError('too_many_requests', { retryAfter: result.retryAfter })
      const token = await core.setup.verifyCode(c.req.valid('json').code)
      if (!token) throw new DomainError('setup_code_invalid')
      setImportCookie(c, 'nextskin-setup', token)
      return c.body(null, 204)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/setup/site',
      request: {
        body: jsonBody(
          z.object({
            siteName: z.string(),
            siteUrl: z.string(),
            email: z.string(),
            nickname: z.string(),
            password: z.string(),
          }),
        ),
      },
      responses: { 201: jsonResult, ...importErrors },
    }),
    async (c) => {
      if (importer?.maintenance()) throw new DomainError('import_running')
      const body = c.req.valid('json')
      const ip = await clientIp(c, core)
      const locale =
        matchLocale(getCookie(c, LOCALE_COOKIE) ?? '') ?? matchAcceptLanguage(c.req.header('accept-language') ?? '')
      const { uid } = await core.setup.createSite({
        ...body,
        setupToken: getCookie(c, 'nextskin-setup') ?? '',
        ip,
        locale,
      })
      setImportCookie(c, 'nextskin-setup', '', 0)
      if (ip === null) return c.json({ uid, signedIn: false }, 201)
      let signedIn = false
      try {
        const cookies = await core.auth.createSession({
          email: body.email.trim().toLowerCase(),
          password: body.password,
          clientIp: ip,
          userAgent: c.req.header('user-agent') ?? null,
          requestRoot: c.get('requestRoot'),
        })
        for (const cookie of cookies) c.header('Set-Cookie', cookie, { append: true })
        signedIn = true
      } catch (error) {
        logError(error)
      }
      return c.json({ uid, signedIn }, 201)
    },
  )
  if (!importer) return
  app.openapi(
    createRoute({
      method: 'post',
      path: '/setup/import/env',
      request: { body: jsonBody(envSchema) },
      responses: { 200: jsonResult, ...importErrors },
    }),
    (c) => {
      const { text, directory } = c.req.valid('json')
      return c.json(importer.parseEnv(text, directory), 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/setup/import/check',
      request: { body: jsonBody(sourceSchema) },
      responses: { 200: jsonResult, ...importErrors },
    }),
    async (c) => c.json(await importer.check(c.req.valid('json')), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/setup/import/runs',
      request: { body: jsonBody(startSchema) },
      responses: { 202: jsonResult, ...importErrors },
    }),
    async (c) => {
      const { token, state } = await importer.start(c.req.valid('json'), { entry: 'setup', startedBy: null })
      setImportCookie(c, 'nextskin-import-run', token)
      return c.json({ run: state }, 202)
    },
  )
}
