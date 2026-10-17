import type { AppEnv } from './env.ts'
import type { Core } from '@nextskin/domain'
import type { Hono } from 'hono'
import { clientIp } from './client-ip.ts'

/** 网页登录、OAuth/OIDC 授权服务器（ADR-0007）。请求原样交给领域层，路由和业务规则都在 Better Auth 及其配置里 */
export function registerAuth(app: Hono<AppEnv>, core: Core) {
  app.all('/api/auth/*', async (c) => core.auth.handle(c.req.raw, c.get('requestRoot'), await clientIp(c, core)))
}
