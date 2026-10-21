import { createMiddleware } from 'hono/factory'
import type { ImportGateway } from './import-gateway.ts'
import { createErrorResponse } from './rest/errors.ts'
import type { AppEnv } from './env.ts'
import { YggdrasilError, type Core } from '@nextskin/domain'
import { Hono } from 'hono'
import { registerAuth } from './auth.ts'
import { registerCsl } from './protocol/csl.ts'
import { requestRoot } from './protocol/http.ts'
import { registerLegacy } from './protocol/legacy.ts'
import { registerTextures } from './protocol/textures.ts'
import { registerUsm } from './protocol/usm.ts'
import { registerYggdrasil, yggdrasilError } from './protocol/yggdrasil.ts'
import { registerPluginRoutes } from './plugins.ts'
import { registerRender } from './render.ts'
import { registerSiteImages } from './site-images.ts'
import { createRestApp } from './rest/app.ts'
import { createMemoryRateLimiter } from './rest/rate-limit.ts'

/** 所有非页面的 HTTP 端点；只依赖领域查询，不直接访问数据库。 */
export function createApp(options: { core: Core; importer?: ImportGateway }) {
  const { core, importer } = options
  const uploadRateLimiter = createMemoryRateLimiter(Date.now, { limit: 10, windowMs: 60_000 })
  // 末尾带斜杠的路径与不带斜杠的相同：BS（nginx + Laravel）就是这样，authlib-injector 请求元数据时会带上斜杠
  const app = new Hono<AppEnv>({ strict: false })
  // 不交给 Hono 的默认处理器打印底层错误，避免日志泄露设置或数据库信息。
  app.onError((error, c) =>
    error instanceof YggdrasilError
      ? yggdrasilError(c, core, error)
      : new Response('Internal Server Error', { status: 500, headers: { 'Cache-Control': 'no-cache, private' } }),
  )
  app.use(
    '*',
    createMiddleware<AppEnv>(async (c, next) => {
      if (!importer?.maintenance()) return next()
      const path = c.req.path.replace(/\/+$/, '')
      if (
        path === '/api/health' ||
        // 站点图片只读存储，不碰数据库（ADR-0042）
        path.startsWith('/site-images/') ||
        path === '/api/setup' ||
        path.startsWith('/api/setup/') ||
        path === '/api/import/run' ||
        path.startsWith('/api/import/run/')
      )
        return next()
      c.header('Retry-After', '30')
      c.header('Cache-Control', 'no-cache, private')
      return path.startsWith('/api/') && path !== '/api/yggdrasil' && !path.startsWith('/api/yggdrasil/')
        ? createErrorResponse(core, {}, true)(c, 'maintenance')
        : c.text('Service Unavailable', 503)
    }),
  )
  app.use('*', async (c, next) => {
    const settings = importer?.maintenance()
      ? { 'yggdrasil.apiLocationIndication': false }
      : await core.settings.read(['yggdrasil.apiLocationIndication'])
    const root = requestRoot(c.req.raw)
    c.set('requestRoot', root)
    await next()
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-cache, private')
    if (settings['yggdrasil.apiLocationIndication'] && !c.get('omitAli')) {
      c.header('X-Authlib-Injector-API-Location', `${c.get('profileRoot') ?? root}/api/yggdrasil`)
    }
  })
  app.get('/api/health', (c) => c.json({ status: 'ok' }))
  registerAuth(app, core)
  registerYggdrasil(app, core, uploadRateLimiter)
  registerTextures(app, core)
  registerLegacy(app, core)
  registerUsm(app, core)
  registerCsl(app, core)
  registerRender(app, core)
  registerSiteImages(app, core)
  registerPluginRoutes(app, core)
  // REST 的通配中间件排在协议处理器后，避免协议请求经过 REST 的校验和设置读取。
  app.route('/api', createRestApp(core, { uploadRateLimiter, importer }))
  return app
}
