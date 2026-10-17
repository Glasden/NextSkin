import type { AppEnv } from '../env.ts'
import type { Core, PlayerView, SigningKey } from '@nextskin/domain'
import type { Hono } from 'hono'
import {
  isJsonRequest,
  protocolMethodResponse,
  siteRoot,
  uniqueProfileInputs,
  unsignedFromQuery,
  errorPage,
  requiresSignature,
  skinDomains,
  type ProtocolContext,
} from './http.ts'

/** BS 的 YggdrasilException 直接输出响应并退出，绕过了所有中间件，所以不带 ALI 头。 */
function yggdrasilError(
  c: ProtocolContext,
  error: 'IllegalArgumentException' | 'ForbiddenOperationException',
  errorMessage: string,
) {
  c.set('omitAli', true)
  return c.json({ error, errorMessage }, error === 'IllegalArgumentException' ? 400 : 403)
}

const SIGNING_KEY_UNAVAILABLE =
  'The signing key of this server is missing or invalid. Please contact the site administrator.'

function profileProperties(player: PlayerView, root: string, key: SigningKey | null) {
  const textures: Record<string, unknown> = {}
  if (player.skin) {
    textures.SKIN = {
      url: `${root}/textures/${player.skin.hash}`,
      ...(player.skin.type === 'steve' ? {} : { metadata: { model: 'slim' } }),
    }
  }
  if (player.cape) textures.CAPE = { url: `${root}/textures/${player.cape.hash}` }
  const value = Buffer.from(
    JSON.stringify({
      timestamp: Date.now(),
      profileId: player.uuid,
      profileName: player.name,
      isPublic: true,
      textures,
      ...(key ? { signatureRequired: true } : {}),
    }),
    'utf8',
  ).toString('base64')
  return [
    { name: 'textures', value },
    { name: 'uploadableTextures', value: 'skin,cape' },
  ].map((property) => (key ? { ...property, signature: key.sign(property.value) } : property))
}

export function registerYggdrasil(app: Hono<AppEnv>, core: Core): void {
  const prefix = '/api/yggdrasil'
  app.all(prefix, async (c) => {
    const settings = await core.settings.read(['site.name', 'site.url', 'yggdrasil.skinDomains'])
    const key = await core.yggdrasil.getSigningKey()
    if (!key) return yggdrasilError(c, 'IllegalArgumentException', SIGNING_KEY_UNAVAILABLE)
    const root = c.get('requestRoot')
    return c.json({
      meta: {
        serverName: settings['site.name'],
        implementationName: 'NextSkin',
        implementationVersion: '0.0.0',
        links: { homepage: root, register: `${root}/auth/register` },
        'feature.non_email_login': true,
      },
      skinDomains: skinDomains(settings['yggdrasil.skinDomains'], settings['site.url'], root),
      signaturePublickey: key.publicKey,
    })
  })
  app.all(`${prefix}/sessionserver/session/minecraft/profile/:uuid`, async (c) => {
    const uuid = c.req.param('uuid')
    if (uuid.includes('/')) return errorPage(404)
    const methodResponse = protocolMethodResponse(c.req.method, 'GET')
    if (methodResponse) return methodResponse
    const player = await core.players.findByUuid(uuid)
    if (!player) return c.body(null, 204)
    const signed = requiresSignature(unsignedFromQuery(new URL(c.req.url).searchParams))
    const key = signed ? await core.yggdrasil.getSigningKey() : null
    if (signed && !key) return yggdrasilError(c, 'IllegalArgumentException', SIGNING_KEY_UNAVAILABLE)
    const { 'site.url': siteUrl } = await core.settings.read(['site.url'])
    const root = siteRoot(siteUrl, c.get('requestRoot'))
    c.set('profileRoot', root)
    return c.json({ id: player.uuid, name: player.name, properties: profileProperties(player, root, key) })
  })
  app.all(`${prefix}/api/profiles/minecraft`, async (c) => {
    const methodResponse = protocolMethodResponse(c.req.method, 'POST')
    if (methodResponse) return methodResponse
    // BS 不看 Content-Type，总是按 JSON 解析请求体；但只有 JSON 请求才会被 TrimStrings 处理。
    const body: unknown = await c.req.json().catch(() => null)
    const unique = uniqueProfileInputs(body, isJsonRequest(c.req.raw))
    const { 'yggdrasil.profileSearchLimit': limit } = await core.settings.read(['yggdrasil.profileSearchLimit'])
    if (unique.length > limit) {
      return yggdrasilError(c, 'ForbiddenOperationException', `You can query up to ${limit} players in one request.`)
    }
    const profiles: { id: string; name: string }[] = []
    for (const name of unique) {
      if (typeof name !== 'string' || name === '') continue
      const player = await core.players.findByName(name)
      // 返回请求里的名字，不是角色名
      if (player) profiles.push({ id: player.uuid, name })
    }
    return c.json(profiles)
  })
  app.all(`${prefix}/api/users/profiles/minecraft/:username`, async (c) => {
    const name = c.req.param('username')
    if (name.includes('/')) return errorPage(404)
    const methodResponse = protocolMethodResponse(c.req.method, 'GET')
    if (methodResponse) return methodResponse
    const player = await core.players.findByName(name)
    return player ? c.json({ id: player.uuid, name }) : c.body(null, 204)
  })
}
