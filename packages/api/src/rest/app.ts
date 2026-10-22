import { registerNotifications } from './notifications.ts'
import { registerOAuthClients } from './oauth-clients.ts'
import { registerDevices } from './devices.ts'
import { registerUserAuthorizations } from './user-authorizations.ts'
import type { ImportGateway } from '../import-gateway.ts'
import { registerSetup } from './setup.ts'
import { registerImport } from './import.ts'
import { registerAdmin } from './admin.ts'
import { MAX_PLUGIN_PACKAGE_REQUEST_BYTES, registerPluginAdmin } from './plugins.ts'
import { OpenAPIHono } from '@hono/zod-openapi'
import { DomainError, SITE_IMAGE_MAX_BYTES, type Core } from '@nextskin/domain'
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
import { registerExternalLogin } from './external-login.ts'
import { registerTextures } from './textures.ts'
import { registerYggdrasilTokens } from './yggdrasil-tokens.ts'

/** 上传插件包的两个接口：请求体是 multipart，上限按插件包算 */
const PLUGIN_PACKAGE_PATH = /\/admin\/plugin-packages(?:\/preview)?\/?$/
/** 上传站点图片（ADR-0042）：multipart，图片最大 1 MiB */
const SITE_IMAGE_PATH = /\/admin\/site-images\/?$/
export function createRestApp(
  core: Core,
  options: { rateLimiter?: RateLimiter; uploadRateLimiter?: RateLimiter; importer?: ImportGateway } = {},
) {
  const rateLimiter = options.rateLimiter ?? createMemoryRateLimiter()
  const errorResponse = createErrorResponse(core, {}, () => options.importer?.maintenance() ?? false)
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
      () => options.importer?.maintenance() ?? false,
    )
    return error instanceof DomainError ? respond(c, code, error.params, error.fields) : respond(c, code)
  })
  app.use(
    '*',
    createMiddleware<AppEnv>(async (c, next) => {
      const pluginPackage = PLUGIN_PACKAGE_PATH.test(c.req.path)
      if (c.req.method === 'POST' && (pluginPackage || SITE_IMAGE_PATH.test(c.req.path))) {
        // 插件包（ADR-0033"安装"）和站点图片：和材质一样逐块计数，不信任 Content-Length；multipart 的其余部分另外留 64 KiB
        const maxSize = pluginPackage ? MAX_PLUGIN_PACKAGE_REQUEST_BYTES : SITE_IMAGE_MAX_BYTES + 64 * 1024
        const tooLarge = () =>
          pluginPackage
            ? new DomainError('plugin_package_invalid', { reason: 'too_large' })
            : new DomainError('site_image_file_invalid')
        if (Number(c.req.header('content-length')) > maxSize) throw tooLarge()
        const headers = new Headers(c.req.raw.headers)
        headers.delete('content-length')
        c.req.raw = new Request(c.req.raw, { headers })
        const limit = bodyLimit({
          maxSize,
          onError: () => {
            throw tooLarge()
          },
        }) as MiddlewareHandler<AppEnv>
        return limit(c, next)
      }
      if (c.req.method !== 'POST' || !/\/textures\/?$/.test(c.req.path)) {
        // 设置里的公告和内容政策各能写 20000 个字，按 UTF-8 最多 4 字节一个字算（ADR-0028）
        const maxSize =
          c.req.method === 'POST' && /\/(?:setup|admin)\/import\/runs\/?$/.test(c.req.path)
            ? 1024 * 1024
            : c.req.method === 'PATCH' && /\/admin\/settings\/?$/.test(c.req.path)
              ? 192 * 1024
              : c.req.method === 'POST' && /\/admin\/notifications\/?$/.test(c.req.path)
                ? 32 * 1024
                : 16 * 1024
        if (maxSize === 1024 * 1024) {
          if (Number(c.req.header('content-length')) > maxSize) throw new DomainError('request_too_large')
          const headers = new Headers(c.req.raw.headers)
          headers.delete('content-length')
          c.req.raw = new Request(c.req.raw, { headers })
        }
        const limit = bodyLimit({ maxSize }) as MiddlewareHandler<AppEnv>
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
      const settings = options.importer?.maintenance() ? { 'site.url': '' } : await core.settings.read(['site.url'])
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
        c.req.method === 'POST' &&
        (/\/textures\/?$/.test(c.req.path) || PLUGIN_PACKAGE_PATH.test(c.req.path) || SITE_IMAGE_PATH.test(c.req.path))
      ) {
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
  registerExternalLogin(app, core)
  registerCloset(app, core)
  registerReports(app, core)
  registerNotifications(app, core)
  registerAdmin(app, core)
  registerPluginAdmin(app, core)
  registerSetup(app, core, options.importer)
  if (options.importer) {
    registerImport(app, core, options.importer)
  }
  registerPlayers(app, core)
  registerCheckIn(app, core)
  registerUser(app, core, rateLimiter)
  registerYggdrasilTokens(app, core)
  registerDevices(app, core)
  registerUserAuthorizations(app, core)
  registerOAuthClients(app, core)
  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'NextSkin REST API', version: '1.0.0' },
    servers: [{ url: '/api' }],
  })
  return app
}
