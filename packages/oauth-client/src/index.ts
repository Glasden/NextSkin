/**
 * 官方第三方登录插件共用的部分（ADR-0034）：拼授权地址、换令牌、读 ID 令牌。不发布，`nextskin-plugin build` 把它打进
 * 每个插件的单文件里，所以只用 Web 标准 API 和 Node 内置模块；出站请求一律用调用方传进来的 `ctx.fetch`。
 * 错误消息只写笼统的原因，不带授权码、令牌和响应体。
 */
export type Fetch = (request: Request) => Promise<Response>

export function authorizationUrl(
  endpoint: string,
  args: { clientId: string; redirectUri: string; state: string; codeChallenge: string },
  extra: Readonly<Record<string, string>> = {},
): string {
  const url = new URL(endpoint)
  url.search = new URLSearchParams({
    ...extra,
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.href
}

/** 连网络异常也换成固定消息：底层错误可能带上请求里的机密。 */
export async function fetchJson(fetch: Fetch, request: Request, stage: 'token' | 'user'): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(request)
  } catch {
    throw new Error(`${stage} request failed`)
  }
  if (!response.ok) throw new Error(`${stage} request failed: ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new Error(`invalid ${stage} response`)
  }
}

export async function exchangeCode(
  fetch: Fetch,
  endpoint: string,
  args: {
    query: Readonly<Record<string, string>>
    codeVerifier: string
    redirectUri: string
    clientId: string
    clientSecret: string
  },
): Promise<Record<string, unknown>> {
  if (!args.query.code) throw new Error('missing authorization code')
  const value = await fetchJson(
    fetch,
    new Request(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: args.query.code,
        redirect_uri: args.redirectUri,
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code_verifier: args.codeVerifier,
      }),
    }),
    'token',
  )
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'error' in value)
    throw new Error('invalid token response')
  return value as Record<string, unknown>
}

/** 只用于经 TLS 从令牌端点直接拿到的 ID 令牌，以 TLS 代替验签（OIDC Core 3.1.3.7）。 */
export function readIdToken(
  token: unknown,
  args: { clientId: string; issuers: readonly string[]; now?: number },
): Record<string, unknown> {
  let claims: Record<string, unknown>
  try {
    if (typeof token !== 'string') throw new Error()
    const parts = token.split('.')
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error()
    const value: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    claims = value as Record<string, unknown>
  } catch {
    throw new Error('invalid ID token')
  }
  const { aud, iss, exp } = claims
  const audiences = typeof aud === 'string' ? [aud] : aud
  if (
    !Array.isArray(audiences) ||
    !audiences.every((audience: unknown) => typeof audience === 'string') ||
    !audiences.includes(args.clientId) ||
    typeof iss !== 'string' ||
    !args.issuers.includes(iss) ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp) ||
    // 容许三分钟的时钟偏差，不接受没有期限的令牌。
    exp <= (args.now ?? Date.now() / 1000) - 180
  )
    throw new Error('invalid ID token claims')
  return claims
}
