import type { AppEnv } from '../env.ts'
import type { Core } from '@nextskin/domain'
import type { Hono } from 'hono'
import { errorPage, protocolMethodResponse, suffixPlayer } from './http.ts'

export function registerLegacy(app: Hono<AppEnv>, core: Core): void {
  for (const kind of ['skin', 'cape'] as const) {
    app.all(`/${kind}/:file`, async (c) => {
      const name = suffixPlayer(c.req.param('file'), '.png')
      if (name === null) return errorPage(404)
      const methodResponse = protocolMethodResponse(c.req.method, 'GET')
      if (methodResponse) return methodResponse
      const player = await core.players.findByName(name)
      if (!player) return errorPage(404)
      if (player.ownerBanned) return errorPage(403)
      const texture = player[kind]
      if (!texture) return errorPage(404)
      const file = await core.textures.readFile(texture.hash)
      return file ? new Response(Buffer.from(file.bytes), { headers: { 'Content-Type': 'image/png' } }) : errorPage(404)
    })
  }
}
