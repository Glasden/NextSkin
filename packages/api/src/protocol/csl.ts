import type { Core } from '@nextskin/domain'
import type { Hono } from 'hono'
import {
  publicCacheResponse,
  protocolMethodResponse,
  errorPage,
  httpDate,
  suffixPlayer,
  type ProtocolEnv,
} from './http.ts'

export function registerCsl(app: Hono<ProtocolEnv>, core: Core): void {
  app.on('ALL', ['/:file', '/csl/:file'], async (c) => {
    const name = suffixPlayer(c.req.param('file'), '.json')
    if (name === null) return errorPage(404)
    const methodResponse = protocolMethodResponse(c.req.method, 'GET')
    if (methodResponse) return methodResponse
    const player = await core.players.findByName(name)
    const { 'cache.publicMaxAge': maxAge } = await core.settings.read(['cache.publicMaxAge'])
    if (!player || player.ownerBanned) {
      const response = errorPage(player ? 403 : 404)
      response.headers.set('Cache-Control', `max-age=${maxAge}, no-cache, public`)
      return response
    }
    const model = player.skin?.type === 'alex' ? 'slim' : 'default'
    const response = c.json({
      username: player.name,
      skins: { [model]: player.skin?.hash ?? null },
      cape: player.cape?.hash ?? null,
    })
    response.headers.set('Last-Modified', httpDate(player.updatedAt))
    return publicCacheResponse(c.req.raw, response, maxAge)
  })
}
