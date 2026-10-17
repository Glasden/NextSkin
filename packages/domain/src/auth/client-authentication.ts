// 保密客户端在令牌、内省、撤销端点上，用 HTTP Basic 或请求体传 client_secret 都可以。
//
// Passport（BS 用的 OAuth 服务端）两种方式都接受，导入的第三方应用不知道用的是哪一种（docs/schema.md
// "oauth_clients → oauth_clients"）；Better Auth 只接受客户端登记的那一种，另一种返回 invalid_client。
// 两种方式传的是同一个密钥，互相转换不改变安全性，所以对所有保密客户端一视同仁，不区分是否导入。
//
// Better Auth 认证客户端时会重新读取原始请求体和 Authorization 头，钩子里改 ctx.body 不起作用，
// 只能在请求进入 Better Auth 之前改写 Request 本身。

const PATHS = ['/oauth2/token', '/oauth2/introspect', '/oauth2/revoke']

/** 查客户端登记的认证方式；客户端不存在时返回 undefined。没有登记时 Better Auth 按 client_secret_basic 处理 */
export type RegisteredAuthMethod = (clientId: string) => Promise<string | null | undefined>

export async function normalizeClientAuthentication(
  request: Request,
  basePath: string,
  registeredMethod: RegisteredAuthMethod,
): Promise<Request> {
  if (request.method !== 'POST') return request
  const path = new URL(request.url).pathname
  if (!PATHS.some((suffix) => path === `${basePath}${suffix}`)) return request
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/x-www-form-urlencoded')) return request

  const params = new URLSearchParams(await request.clone().text())
  // 参数重复、同时用了多种方式、带了 client_assertion：原样交给 Better Auth 报错
  for (const name of ['client_id', 'client_secret', 'client_assertion', 'client_assertion_type'])
    if (params.getAll(name).length > 1) return request
  if (params.has('client_assertion') || params.has('client_assertion_type')) return request

  const authorization = request.headers.get('authorization')
  if (authorization) {
    if (params.has('client_secret')) return request
    const credentials = decodeBasic(authorization)
    if (!credentials) return request
    if (params.has('client_id') && params.get('client_id') !== credentials.clientId) return request
    if ((await registeredMethod(credentials.clientId)) !== 'client_secret_post') return request
    params.set('client_id', credentials.clientId)
    params.set('client_secret', credentials.clientSecret)
    const headers = new Headers(request.headers)
    headers.delete('authorization')
    return rebuild(request, headers, params)
  }

  const clientId = params.get('client_id')
  const clientSecret = params.get('client_secret')
  if (!clientId || !clientSecret) return request
  const method = await registeredMethod(clientId)
  // null 表示客户端存在但没有登记认证方式，Better Auth 把它当成 client_secret_basic
  if (method !== 'client_secret_basic' && method !== null) return request
  params.delete('client_secret')
  const headers = new Headers(request.headers)
  headers.set('authorization', encodeBasic(clientId, clientSecret))
  return rebuild(request, headers, params)
}

function rebuild(request: Request, headers: Headers, params: URLSearchParams): Request {
  headers.delete('content-length')
  return new Request(request.url, { method: request.method, headers, body: params.toString(), signal: request.signal })
}

// RFC 6749 §2.3.1：client_id 和 client_secret 先按 application/x-www-form-urlencoded 编码，再拼接、做 base64
function formEncode(value: string): string {
  return new URLSearchParams([['', value]]).toString().slice(1)
}

function formDecode(value: string): string {
  return new URLSearchParams(`v=${value}`).get('v') ?? ''
}

function encodeBasic(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`, 'utf8').toString('base64')}`
}

function decodeBasic(authorization: string): { clientId: string; clientSecret: string } | null {
  // 只认 Better Auth 自己也接受的写法（scheme 后面只能是空格）：改写不能让它本来会拒绝的请求通过
  const match = /^basic +([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)
  if (!match) return null
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator <= 0) return null
  const clientId = formDecode(decoded.slice(0, separator))
  const clientSecret = formDecode(decoded.slice(separator + 1))
  return clientId && clientSecret ? { clientId, clientSecret } : null
}
