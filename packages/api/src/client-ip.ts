import { resolveClientIp, type Core } from '@nextskin/domain'
import type { Context } from 'hono'
import type { AppEnv } from './env.ts'

export async function clientIp(c: Context<AppEnv>, core: Core): Promise<string | null> {
  const settings = await core.settings.read(['network.trustedProxies'])
  return resolveClientIp({
    forwardedFor: c.req.header('x-forwarded-for') ?? null,
    peer: c.env?.peer ?? null,
    trustedProxies: settings['network.trustedProxies'],
  })
}
