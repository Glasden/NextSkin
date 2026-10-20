import type { GenericEndpointContext } from '@better-auth/core'
import { isBrowserFetchRequest } from '@better-auth/core/utils/fetch-metadata'
import { isLoopbackIP } from '@better-auth/core/utils/host'
import { appendQueryParams } from '@better-auth/core/utils/url'
import { getIssuer, verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { readAuthBoolean, type CoreDatabase } from '@nextskin/db'
import type { Kysely, Selectable } from 'kysely'
import { readScopes } from '../oauth/scopes.ts'

/** 与 Better Auth 的 prompt 解析一致；制表符只在 token 两端去掉，不能把它当成分隔符。 */
export function splitPrompt(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)
}

type AuthorizationClient = Pick<
  Selectable<CoreDatabase['oauth_clients']>,
  'client_id' | 'disabled' | 'grant_types' | 'redirect_uris' | 'scopes' | 'token_endpoint_auth_method'
>

export async function authorizationClient(db: Kysely<CoreDatabase>, clientId: unknown) {
  if (typeof clientId !== 'string') return undefined
  return db
    .selectFrom('oauth_clients')
    .select(['client_id', 'disabled', 'grant_types', 'redirect_uris', 'scopes', 'token_endpoint_auth_method'])
    .where('client_id', '=', clientId)
    .executeTakeFirst()
}

// 复制自 @better-auth/oauth-provider 1.7.10 authorize.ts 的同名函数：只放宽 HTTP 环回地址的端口，
// 不能用 URL 序列化后的值比较，否则会把大小写、转义等额外差异也当成相同地址。
function stripLoopbackRedirectPort(uri: string) {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return
  }
  const isLoopback = isLoopbackIP(parsed.hostname) || parsed.hostname === 'localhost'
  if (parsed.protocol !== 'http:' || !isLoopback) return
  const schemeSeparatorIndex = uri.indexOf('://')
  if (schemeSeparatorIndex < 0) return
  const authorityStart = schemeSeparatorIndex + 3
  const authorityEndOffset = uri.slice(authorityStart).search(/[/?#]/u)
  let authorityEnd = uri.length
  if (authorityEndOffset >= 0) authorityEnd = authorityStart + authorityEndOffset
  const authority = uri.slice(authorityStart, authorityEnd)
  let portStart: number
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']')
    if (closingBracket < 0) return
    if (authority[closingBracket + 1] !== ':') return uri
    portStart = closingBracket + 1
  } else {
    portStart = authority.lastIndexOf(':')
    if (portStart < 0) return uri
  }
  const port = authority.slice(portStart + 1)
  if (!/^\d*$/u.test(port)) return
  const portStartInUri = authorityStart + portStart
  return `${uri.slice(0, portStartInUri)}${uri.slice(authorityEnd)}`
}

// 同上，来自 1.7.10 的 findRegisteredRedirectUri；包括空片段和 userinfo 的拒绝规则。
function findRegisteredRedirectUri(registered: string[], requested: string) {
  if (!requested) return
  let requestedUrl: URL
  try {
    requestedUrl = new URL(requested)
  } catch {
    return
  }
  if (requested.includes('#') || requestedUrl.username.length > 0 || requestedUrl.password.length > 0) return
  const requestedWithoutPort = stripLoopbackRedirectPort(requested)
  return registered.find((url) => {
    if (url === requested) return true
    if (!requestedWithoutPort) return false
    return stripLoopbackRedirectPort(url) === requestedWithoutPort
  })
}

/** 错误只能发往已核实的回调地址；检查顺序与 Better Auth 的 authorize 一致。 */
export function authorizationTrustError(
  client: AuthorizationClient | undefined,
  clientId: unknown,
  redirectUri: unknown,
): string | null {
  if (!client || client.client_id !== clientId) return 'invalid_client'
  if (readAuthBoolean(client.disabled ?? false)) return 'client_disabled'
  const grants = readScopes(client.grant_types)
  // Better Auth 的 clientAllowsGrant 把未登记或空的 grant_types 当成允许授权码。
  if (grants.length && !grants.includes('authorization_code')) return 'unauthorized_client'
  if (typeof redirectUri !== 'string' || !findRegisteredRedirectUri(readScopes(client.redirect_uris), redirectUri))
    return 'invalid_redirect'
  return null
}

export function authorizationError(
  ctx: GenericEndpointContext,
  params: Record<string, unknown>,
  client: AuthorizationClient | undefined,
  error: string,
  description: string,
) {
  const trustError = authorizationTrustError(client, params.client_id, params.redirect_uri)
  const descriptions: Record<string, string> = {
    invalid_client: 'Invalid client',
    client_disabled: 'Client is disabled',
    unauthorized_client: 'Client is not allowed to use authorization code grants',
    invalid_redirect: 'Invalid redirect_uri',
  }
  const query = new URLSearchParams({
    error: trustError ?? error,
    error_description: trustError ? descriptions[trustError]! : description,
  })
  let url: string
  if (trustError) url = appendQueryParams('/oauth/error', query)
  else {
    if (typeof params.state === 'string' && params.state) query.append('state', params.state)
    query.append(
      'iss',
      getIssuer(ctx, (ctx.context.getPlugin('oauth-provider')?.options ?? {}) as Parameters<typeof getIssuer>[1]),
    )
    url = appendQueryParams(String(params.redirect_uri), query)
  }
  if (isBrowserFetchRequest(ctx.request?.headers) || ctx.headers?.get('accept')?.includes('application/json'))
    return { redirect: true, url }
  throw ctx.redirect(url)
}

/** 与 Better Auth 浏览器端 buildSignedOAuthQuery 一致：页面自己的未签名参数不参与验签或续跑。 */
export async function signedAuthorizationQuery(search: string, secret: string): Promise<URLSearchParams | null> {
  const params = new URLSearchParams(search)
  if (!params.has('sig') || !params.has('ba_param')) return null
  const names = new Set(params.getAll('ba_param'))
  const signed = new URLSearchParams()
  for (const [key, value] of params)
    if (key === 'sig' || key === 'ba_param' || names.has(key)) signed.append(key, value)
  return (await verifyOAuthQueryParams(signed.toString(), secret)) ? signed : null
}
