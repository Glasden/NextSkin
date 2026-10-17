import type { Core } from '@nextskin/domain'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../env.ts'
import { createErrorResponse } from './errors.ts'

export function requireSession(core: Core) {
  const errorResponse = createErrorResponse(core)
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = await core.auth.getSessionUser(c.req.raw.headers, c.get('requestRoot'))
    if (!user) return errorResponse(c, 'unauthenticated')
    c.set('user', user)
    await next()
  })
}
