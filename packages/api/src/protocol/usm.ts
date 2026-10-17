import type { AppEnv } from '../env.ts'
import type { Core } from '@nextskin/domain'
import type { Hono } from 'hono'
import { errorPage, protocolMethodResponse, suffixPlayer } from './http.ts'

export function registerUsm(app: Hono<AppEnv>, core: Core): void {
  app.all('/usm/:file', async (c) => {
    const name = suffixPlayer(c.req.param('file'), '.json')
    if (name === null) return errorPage(404)
    const methodResponse = protocolMethodResponse(c.req.method, 'GET')
    if (methodResponse) return methodResponse
    const player = await core.players.findByName(name)
    if (!player) return c.json({ errno: 1, msg: 'Player not found.' }, 404)
    if (player.ownerBanned) return errorPage(403)
    const model = !player.skin || player.skin.type === 'steve' ? 'default' : 'slim'
    return c.json({
      player_name: player.name,
      last_update: Math.floor(Date.parse(player.updatedAt) / 1000),
      model_preference: [model],
      skins: { [model]: player.skin?.hash ?? null },
      cape: player.cape?.hash ?? null,
    })
  })
}
