/**
 * 三家 CDN 的刷新接口。每个函数只负责签名、发请求和判断结果；失败一律抛错，由核心按退避重试，
 * 多次失败后进入死信（ADR-0021）。签名只用 Web Crypto，在核心进程内和 plugin host 里都能跑。
 */

export interface Credentials {
  accessKeyId: string
  accessKeySecret: string
}

export interface AzureTarget {
  tenantId: string
  subscriptionId: string
  resourceGroup: string
  profile: string
  endpoint: string
}

type Fetch = (input: Request) => Promise<Response>

/** 每次请求最多带这么多个地址：三家的上限都不低于它 */
export const BATCH_SIZE = 100

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hmac(key: string | Uint8Array<ArrayBuffer>, data: string, hash: 'SHA-1' | 'SHA-256') {
  const raw = typeof key === 'string' ? encoder.encode(key) : key
  const cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)))
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(data)))
}

/** 响应里的错误信息只取前一小段：可能很长，也可能带着请求的细节 */
async function failure(service: string, response: Response, detail?: string): Promise<Error> {
  const text = detail ?? (await response.text().catch(() => ''))
  return new Error(`${service} 刷新失败：HTTP ${response.status} ${[...text].slice(0, 200).join('')}`.trim())
}

// ---- 阿里云 CDN：RefreshObjectCaches，RPC 风格签名（HMAC-SHA1） ----

/** 阿里云的 percentEncode：RFC 3986，空格是 %20，`*` 编码，`~` 不编码 */
export function aliyunEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export async function aliyunSignature(
  method: string,
  params: Readonly<Record<string, string>>,
  secret: string,
): Promise<{ canonical: string; signature: string }> {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${aliyunEncode(key)}=${aliyunEncode(params[key]!)}`)
    .join('&')
  const stringToSign = `${method}&${aliyunEncode('/')}&${aliyunEncode(canonical)}`
  const signature = btoa(String.fromCharCode(...(await hmac(`${secret}&`, stringToSign, 'SHA-1'))))
  return { canonical, signature }
}

export async function refreshAliyun(
  urls: readonly string[],
  credentials: Credentials,
  fetch: Fetch,
  now = new Date(),
): Promise<void> {
  const params = {
    Action: 'RefreshObjectCaches',
    Version: '2018-05-10',
    Format: 'JSON',
    ObjectPath: urls.join('\n'),
    ObjectType: 'File',
    AccessKeyId: credentials.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  const { canonical, signature } = await aliyunSignature('GET', params, credentials.accessKeySecret)
  const response = await fetch(
    new Request(`https://cdn.aliyuncs.com/?${canonical}&Signature=${aliyunEncode(signature)}`),
  )
  if (!response.ok) throw await failure('阿里云 CDN', response)
}

// ---- 腾讯云 CDN：PurgeUrlsCache，TC3-HMAC-SHA256 签名 ----

const TENCENT_HOST = 'cdn.tencentcloudapi.com'
const TENCENT_CONTENT_TYPE = 'application/json; charset=utf-8'

export async function tencentAuthorization(
  payload: string,
  credentials: Credentials,
  timestamp: number,
  service = 'cdn',
  host = TENCENT_HOST,
): Promise<string> {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:${TENCENT_CONTENT_TYPE}\nhost:${host}\n`,
    'content-type;host',
    await sha256Hex(payload),
  ].join('\n')
  const scope = `${date}/${service}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), scope, await sha256Hex(canonicalRequest)].join('\n')
  const secretDate = await hmac(`TC3${credentials.accessKeySecret}`, date, 'SHA-256')
  const secretService = await hmac(secretDate, service, 'SHA-256')
  const secretSigning = await hmac(secretService, 'tc3_request', 'SHA-256')
  const signature = hex(await hmac(secretSigning, stringToSign, 'SHA-256'))
  return `TC3-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`
}

export async function refreshTencent(
  urls: readonly string[],
  credentials: Credentials,
  fetch: Fetch,
  now = new Date(),
): Promise<void> {
  const payload = JSON.stringify({ Urls: urls })
  const timestamp = Math.floor(now.getTime() / 1000)
  const response = await fetch(
    new Request(`https://${TENCENT_HOST}/`, {
      method: 'POST',
      headers: {
        Authorization: await tencentAuthorization(payload, credentials, timestamp),
        'Content-Type': TENCENT_CONTENT_TYPE,
        'X-TC-Action': 'PurgeUrlsCache',
        'X-TC-Version': '2018-06-06',
        'X-TC-Timestamp': String(timestamp),
      },
      body: payload,
    }),
  )
  if (!response.ok) throw await failure('腾讯云 CDN', response)
  // 腾讯云的接口出错时也是 HTTP 200，错误在 Response.Error 里
  const body = (await response.json().catch(() => null)) as {
    Response?: { Error?: { Code?: string; Message?: string } }
  } | null
  const error = body?.Response?.Error
  if (!body?.Response || error)
    throw await failure('腾讯云 CDN', response, error ? `${error.Code} ${error.Message}` : '响应格式不对')
}

// ---- Azure Front Door：先用应用的客户端凭据换令牌，再清除终结点上的路径 ----

const AZURE_API_VERSION = '2024-02-01'

export async function refreshAzure(
  paths: readonly string[],
  credentials: Credentials,
  target: AzureTarget,
  fetch: Fetch,
): Promise<void> {
  const token = await fetch(
    new Request(`https://login.microsoftonline.com/${encodeURIComponent(target.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.accessKeyId,
        client_secret: credentials.accessKeySecret,
        scope: 'https://management.azure.com/.default',
      }).toString(),
    }),
  )
  // 令牌接口的错误描述里没有机密，但很长：只给状态码
  if (!token.ok) throw await failure('Azure 登录', token, '')
  const { access_token: accessToken } = (await token.json()) as { access_token?: string }
  if (!accessToken) throw new Error('Azure 登录失败：响应里没有令牌')
  const segment = encodeURIComponent
  const response = await fetch(
    new Request(
      `https://management.azure.com/subscriptions/${segment(target.subscriptionId)}/resourceGroups/${segment(target.resourceGroup)}` +
        `/providers/Microsoft.Cdn/profiles/${segment(target.profile)}/afdEndpoints/${segment(target.endpoint)}/purge?api-version=${AZURE_API_VERSION}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentPaths: paths }),
      },
    ),
  )
  // 清除是异步执行的：接受了就返回 202
  if (!response.ok) throw await failure('Azure Front Door', response)
}
