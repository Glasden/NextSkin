import type { AppEnv } from '../env.ts'
import { DomainError, YggdrasilError, type Core, type PlayerView, type SigningKey } from '@nextskin/domain'
import { createTranslator, resolveLocale, type Messages } from '@nextskin/i18n'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { clientIp } from '../client-ip.ts'
import type { RateLimiter } from '../rest/rate-limit.ts'
import {
  isJsonRequest,
  protocolMethodResponse,
  siteRoot,
  uniqueProfileInputs,
  unsignedFromQuery,
  errorPage,
  requiresSignature,
  skinDomains,
  normalizeProtocolInput,
  phpTruthy,
  protocolQuery,
  type ProtocolContext,
} from './http.ts'

/** BS 的 YggdrasilException 直接输出响应并退出，绕过了所有中间件，所以不带 ALI 头。 */
export async function yggdrasilError(c: ProtocolContext, core: Core, error: YggdrasilError) {
  c.set('omitAli', true)
  const errorMessage = await translateError(core, error)
  const statuses = {
    IllegalArgumentException: 400,
    UnauthorizedException: 401,
    ForbiddenOperationException: 403,
    NotFoundException: 404,
  } as const
  if (error.messageKey === 'errors.too_many_requests' && error.params?.retryAfter !== undefined)
    c.header('Retry-After', String(error.params.retryAfter))
  return c.json({ error: error.kind, errorMessage }, statuses[error.kind])
}

async function translateError(core: Core, error: YggdrasilError): Promise<string> {
  const settings = await core.settings.read(['site.locale'])
  const translate = createTranslator(resolveLocale({ user: error.locale, siteDefault: settings['site.locale'] }))
  return translate(
    error.messageKey as
      `yggdrasil.errors.${keyof Messages['yggdrasil']['errors']}` | `errors.${keyof Messages['errors']}`,
    error.params,
  )
}

const signingKeyUnavailable = () =>
  new YggdrasilError('IllegalArgumentException', 'yggdrasil.errors.signing_key_unavailable')
const stringInput = (value: unknown): string | null => (typeof value === 'string' ? value : null)

async function requestObject(c: ProtocolContext): Promise<Record<string, unknown>> {
  let body: unknown = null
  if (isJsonRequest(c.req.raw)) body = await c.req.json().catch(() => null)
  else if (/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
    const query = new URLSearchParams(await c.req.text())
    body = Object.fromEntries([...query.keys()].map((key) => [key, protocolQuery(query, key)]))
  }
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

/** Laravel bearerToken()：取最后一个大小写敏感的 Bearer，遇到逗号截止。 */
function bearerToken(c: ProtocolContext): string | null {
  const header = c.req.header('authorization') ?? ''
  const start = header.lastIndexOf('Bearer ')
  return start < 0 ? null : header.slice(start + 7).split(',')[0]!
}

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

export function registerYggdrasil(app: Hono<AppEnv>, core: Core, uploadRateLimiter: RateLimiter): void {
  const prefix = '/api/yggdrasil'
  app.all(prefix, async (c) => {
    const settings = await core.settings.read(['site.name', 'site.url', 'yggdrasil.skinDomains'])
    const key = await core.yggdrasil.getSigningKey()
    if (!key) throw signingKeyUnavailable()
    const root = c.get('requestRoot')
    const openIdConfigurationUrl = await core.auth.openIdConfigurationUrl(root)
    return c.json({
      meta: {
        serverName: settings['site.name'],
        implementationName: 'NextSkin',
        implementationVersion: '0.0.0',
        links: { homepage: root, register: `${root}/auth/register` },
        'feature.non_email_login': true,
        ...(openIdConfigurationUrl ? { 'feature.openid_configuration_url': openIdConfigurationUrl } : {}),
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
    if (signed && !key) throw signingKeyUnavailable()
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
      throw new YggdrasilError('ForbiddenOperationException', 'yggdrasil.errors.query_limit', null, { count: limit })
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
  for (const action of ['authenticate', 'refresh', 'validate', 'invalidate', 'signout'] as const) {
    app.all(`${prefix}/authserver/${action}`, async (c) => {
      const methodResponse = protocolMethodResponse(c.req.method, 'POST')
      if (methodResponse) return methodResponse
      if (!isJsonRequest(c.req.raw))
        return c.json({
          error: 'Unsupported Media Type',
          errorMessage: await translateError(
            core,
            new YggdrasilError('IllegalArgumentException', 'yggdrasil.errors.content_type'),
          ),
        })
      const raw = await requestObject(c)
      const body = normalizeProtocolInput(raw) as Record<string, unknown>
      const accessToken = stringInput(body.accessToken)
      const clientToken = stringInput(body.clientToken)
      const requestUser = phpTruthy(body.requestUser)
      if (action === 'authenticate' || action === 'signout') {
        const credentials = {
          username: stringInput(body.username),
          password: stringInput(body.password),
          rawPassword: stringInput(raw.password),
        }
        if (action === 'authenticate')
          return c.json(
            await core.yggdrasil.authenticate({
              ...credentials,
              clientToken,
              requestUser,
              ip: await clientIp(c, core),
            }),
          )
        await core.yggdrasil.signout(credentials)
      } else if (action === 'refresh') {
        return c.json(
          await core.yggdrasil.refresh({
            accessToken,
            clientToken,
            requestUser,
            selectedProfile: body.selectedProfile,
            ip: await clientIp(c, core),
          }),
        )
      } else if (action === 'validate') await core.yggdrasil.validate({ accessToken, clientToken })
      else await core.yggdrasil.invalidate({ accessToken })
      return c.body(null, 204)
    })
  }
  app.all(`${prefix}/sessionserver/session/minecraft/join`, async (c) => {
    const methodResponse = protocolMethodResponse(c.req.method, 'POST')
    if (methodResponse) return methodResponse
    const body = normalizeProtocolInput(await requestObject(c)) as Record<string, unknown>
    await core.yggdrasil.join({
      accessToken: stringInput(body.accessToken),
      selectedProfile: stringInput(body.selectedProfile),
      serverId: stringInput(body.serverId),
      ip: await clientIp(c, core),
    })
    return c.body(null, 204)
  })
  app.all(`${prefix}/sessionserver/session/minecraft/hasJoined`, async (c) => {
    const methodResponse = protocolMethodResponse(c.req.method, 'GET')
    if (methodResponse) return methodResponse
    const query = new URL(c.req.url).searchParams
    const input = (name: string) => stringInput(normalizeProtocolInput(protocolQuery(query, name)))
    const player = await core.yggdrasil.hasJoined({
      username: input('username'),
      serverId: input('serverId'),
      ip: input('ip'),
    })
    if (!player) return c.body(null, 204)
    const key = await core.yggdrasil.getSigningKey()
    if (!key) throw signingKeyUnavailable()
    const { 'site.url': siteUrl } = await core.settings.read(['site.url'])
    const root = siteRoot(siteUrl, c.get('requestRoot'))
    c.set('profileRoot', root)
    return c.json({ id: player.uuid, name: player.name, properties: profileProperties(player, root, key) })
  })
  app.all(`${prefix}/api/user/profile/:uuid/:type`, async (c) => {
    const uuid = c.req.param('uuid'),
      type = c.req.param('type')
    if (uuid.includes('/') || type.includes('/')) return errorPage(404)
    const methodResponse = protocolMethodResponse(c.req.method, 'PUT,DELETE')
    if (methodResponse) return methodResponse
    const input = { accessToken: bearerToken(c), uuid, type }
    if (c.req.method === 'DELETE') {
      await core.yggdrasil.resetTexture(input)
      return c.body(null, 204)
    }
    const { 'texture.maxFileSizeKb': max } = await core.settings.read(['texture.maxFileSizeKb'])
    const tooLarge = () =>
      new YggdrasilError('IllegalArgumentException', 'errors.texture_file_too_large', null, { max })
    const maxSize = max * 1024 + 64 * 1024
    if (Number(c.req.header('content-length')) > maxSize) throw tooLarge()
    // 与网页上传相同：不信任 Content-Length，逐块限制整个 multipart 的大小。
    const headers = new Headers(c.req.raw.headers)
    headers.delete('content-length')
    c.req.raw = new Request(c.req.raw, { headers })
    await bodyLimit({
      maxSize,
      onError: () => {
        throw tooLarge()
      },
    })(c, async () => {})
    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    if (file instanceof File && file.size > max * 1024) throw tooLarge()
    await core.yggdrasil.uploadTexture(
      {
        ...input,
        file: file instanceof File ? { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name } : null,
        model: stringInput(form?.get('model')),
      },
      async (uid) => {
        const limit = await uploadRateLimiter.consume(`texture-upload:${uid}`)
        if (!limit.allowed) throw new DomainError('too_many_requests', { retryAfter: limit.retryAfter })
      },
    )
    return c.body(null, 204)
  })
}
