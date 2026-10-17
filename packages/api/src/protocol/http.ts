import type { Context } from 'hono'
import type { AppEnv } from '../env.ts'

export type ProtocolContext = Context<AppEnv>

export function requestRoot(request: Request): string {
  const url = new URL(request.url)
  const scheme =
    request.headers.get('x-forwarded-proto') === 'https' || request.headers.get('x-forwarded-ssl') === 'on'
      ? 'https'
      : 'http'
  const host = (request.headers.get('host') ?? url.host).toLowerCase()
  // Next standalone 的连接始终是 HTTP；代理头只决定公开 scheme，不决定默认端口。
  const port = /:(\d+)$/.exec(host)
  if (!port) return `${scheme}://${host}`
  const hostname = host.slice(0, port.index)
  const number = Number(port[1])
  return `${scheme}://${hostname}${number === 80 ? '' : `:${number}`}`
}

export function siteRoot(siteUrl: string, root: string): string {
  if (!siteUrl) return root
  return siteUrl.replace(/\/+$/, '').replace(/^https?:/, new URL(root).protocol)
}

export function skinDomains(configured: string[], siteUrl: string, root: string): string[] {
  const domains = [...configured]
  if (siteUrl) domains.push(new URL(siteUrl).hostname)
  domains.push(new URL(root).hostname)
  // BS 先去重，后 trim；空白不同的两项 trim 后仍可能相同。
  return [...new Set(domains)].map((domain) => domain.trim())
}

export function httpDate(value: string | number | Date): string {
  return new Date(value).toUTCString()
}

export function isNotModified(requestHeaders: Headers, responseHeaders: Headers): boolean {
  const tags = (requestHeaders.get('if-none-match') ?? '').split(/\s*,\s*/).filter(Boolean)
  if (tags.length) {
    const etag = responseHeaders.get('etag')?.replace(/^W\//, '')
    return tags.some((tag) => {
      const bare = tag.replace(/^W\//, '')
      return bare === '*' || (etag !== undefined && bare === etag)
    })
  }
  const since = parseHttpDate(requestHeaders.get('if-modified-since') ?? '')
  const modified = parseHttpDate(responseHeaders.get('last-modified') ?? '')
  return since !== null && modified !== null && since >= modified
}

export function conditionalResponse(request: Request, response: Response): Response {
  if (!isNotModified(request.headers, response.headers)) return response
  const headers = new Headers(response.headers)
  for (const key of [
    'allow',
    'content-encoding',
    'content-language',
    'content-length',
    'content-md5',
    'content-type',
    'last-modified',
  ]) {
    headers.delete(key)
  }
  return new Response(null, { status: 304, headers })
}

export function errorPage(status: 403 | 404 | 405): Response {
  const messages = { 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed' }
  return new Response(messages[status], {
    status,
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
  })
}

export function suffixPlayer(file: string, suffix: '.json' | '.png'): string | null {
  if (!file.endsWith(suffix)) return null
  const name = file.slice(0, -suffix.length)
  return name && !/[/.]/.test(name) ? name : null
}

// PHP trim() 默认去掉的字符
const PHP_WHITESPACE = new Set([' ', '\t', '\n', '\r', '\0', '\x0B'])

/** PHP 的 trim()。BS 的 TrimStrings 中间件用它处理查询参数和 JSON 请求体里的字符串（路由参数不处理）。 */
export function phpTrim(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && PHP_WHITESPACE.has(value[start]!)) start++
  while (end > start && PHP_WHITESPACE.has(value[end - 1]!)) end--
  return value.slice(start, end)
}

/** Laravel 的 Request::isJson()：只有这种请求，JSON 请求体里的字符串才会被 trim。 */
export function isJsonRequest(request: Request): boolean {
  const type = request.headers.get('content-type') ?? ''
  return type.includes('/json') || type.includes('+json')
}

/** 只有缺省、trim 后为空（ConvertEmptyStringsToNull 把它变成 null）或恰好是 true 时不签名。 */
export function requiresSignature(unsigned: string | readonly string[] | undefined): boolean {
  if (unsigned === undefined) return false
  if (typeof unsigned !== 'string') return true
  const value = phpTrim(unsigned)
  return value !== '' && value !== 'true'
}

/** Laravel 对已匹配路由的 OPTIONS 和不支持的方法的响应。 */
export function protocolMethodResponse(method: string, allowed: 'GET' | 'POST'): Response | null {
  if (method === allowed || (allowed === 'GET' && method === 'HEAD')) return null
  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        Allow: allowed === 'GET' ? 'GET,HEAD' : 'POST',
        'Content-Type': 'text/html; charset=UTF-8',
        'Cache-Control': 'no-cache, private',
      },
    })
  }
  const response = errorPage(405)
  response.headers.set('Allow', allowed === 'GET' ? 'GET, HEAD' : 'POST')
  response.headers.set('Cache-Control', 'no-cache, private')
  return response
}

/** HEAD 在 Laravel 的公开缓存中间件运行之前已经没有响应体。只用于成功的 CSL/材质响应。 */
export function publicCacheResponse(request: Request, response: Response, maxAge: number): Response {
  if (request.method === 'HEAD') {
    const headers = new Headers(response.headers)
    headers.delete('etag')
    headers.set('Cache-Control', headers.has('Last-Modified') ? 'private, must-revalidate' : 'no-cache, private')
    return new Response(null, { status: response.status, headers })
  }
  response.headers.set('Cache-Control', `max-age=${maxAge}, public`)
  return conditionalResponse(request, response)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 只接受带显式 GMT 的 IMF-fixdate 和 RFC 850；完全按 UTC 解析，不依赖进程时区。 */
export function parseHttpDate(value: string, now = Date.now()): number | null {
  const imf = /^[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value)
  const rfc850 = /^[A-Za-z]+, (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value)
  const parts = imf ?? rfc850
  if (!parts) return null
  const day = Number(parts[1])
  const month = MONTHS.indexOf(parts[2]!)
  let year = Number(parts[3])
  const hour = Number(parts[4])
  const minute = Number(parts[5])
  const second = Number(parts[6])
  if (rfc850) year += Math.floor(new Date(now).getUTCFullYear() / 100) * 100
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(hour, minute, second, 0)
  if (rfc850) {
    const cutoff = new Date(now)
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 50)
    if (date.getTime() > cutoff.getTime()) {
      year -= 100
      date.setUTCFullYear(year)
    }
  }
  if (
    month < 0 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null
  return date.getTime()
}

/** PHP 按查询串出现顺序覆盖参数；unsigned[...] 的值是数组，即使内容是 true 也必须签名。 */
export function unsignedFromQuery(query: URLSearchParams): string | readonly string[] | undefined {
  let unsigned: string | readonly string[] | undefined
  for (const [name, value] of query) {
    if (name === 'unsigned') unsigned = value
    else if (name.startsWith('unsigned[')) unsigned = []
  }
  return unsigned
}

function phpString(value: unknown): string {
  if (value === null || value === false) return ''
  if (value === true) return '1'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value).toString() : String(value)
  return 'Array'
}

/** array_unique($request->json()->all())；保留首个值，所有类型都计入查询上限。 */
export function uniqueProfileInputs(body: unknown, trim: boolean): unknown[] {
  const values: unknown[] =
    body === null || body === undefined
      ? []
      : Array.isArray(body)
        ? body
        : typeof body === 'object'
          ? Object.values(body)
          : [body]
  const unique: unknown[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized: unknown = trim && typeof value === 'string' ? phpTrim(value) || null : value
    const key = phpString(normalized)
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(normalized)
    }
  }
  return unique
}
