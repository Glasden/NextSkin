/**
 * `ctx.fetch`：插件的出站请求由核心代发，只能访问 manifest 的 `network` 里声明过的 https origin。
 *
 * 重定向不交给 fetch 自动跟随：每一跳的目标都要再按白名单检查一次。
 * 插件要是绕过 `ctx.fetch` 自己连网，只能靠 plugin host 的进程权限拦（ADR-0033）。
 */
import { BodyTooLargeError, readBody, type SerializedRequest, type SerializedResponse } from '@nextskin/plugin-host'
import { PluginCallRejected } from './errors.ts'

export const MAX_FETCH_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 5
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
/** 由 fetch 自己决定的请求头；插件传了就丢掉 */
const DROPPED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade'])

function allowedUrl(raw: string, network: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PluginCallRejected('出站请求的地址无效')
  }
  if (url.protocol !== 'https:' || url.username || url.password || !network.includes(url.origin))
    throw new PluginCallRejected(`插件没有声明可以访问 ${url.protocol === 'https:' ? url.origin : '非 https 地址'}`)
  return url
}

export async function pluginFetch(
  request: SerializedRequest,
  options: { network: readonly string[]; signal: AbortSignal; fetch?: typeof fetch },
): Promise<SerializedResponse> {
  const doFetch = options.fetch ?? fetch
  let method = String(request.method).toUpperCase()
  if (!METHODS.has(method)) throw new PluginCallRejected(`不支持的请求方法 ${method}`)
  if (!Array.isArray(request.headers)) throw new PluginCallRejected('请求头格式不对')
  const headers = new Headers()
  for (const entry of request.headers) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string')
      throw new PluginCallRejected('请求头格式不对')
    if (!DROPPED_HEADERS.has(entry[0].toLowerCase())) headers.append(entry[0], entry[1])
  }
  let body: Uint8Array | null = request.body instanceof Uint8Array ? request.body : null
  if (body && body.byteLength > MAX_FETCH_BYTES) throw new PluginCallRejected('出站请求体太大')
  let url = allowedUrl(String(request.url), options.network)
  for (let hop = 0; ; hop++) {
    let response: Response
    try {
      response = await doFetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? null : (body as Uint8Array<ArrayBuffer> | null),
        redirect: 'manual',
        signal: options.signal,
      })
    } catch (error) {
      // 只给出错误的种类：底层消息里可能有代理之类的内部地址
      throw new PluginCallRejected(`出站请求失败（${error instanceof Error ? error.name : 'error'}）`)
    }
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel()
      if (hop >= MAX_REDIRECTS) throw new PluginCallRejected('出站请求重定向次数太多')
      url = allowedUrl(new URL(location, url).href, options.network)
      // 同浏览器：303，以及 301、302 的 POST，改成不带请求体的 GET
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
        body = null
        headers.delete('content-type')
      }
      continue
    }
    let bytes: Uint8Array | null
    try {
      bytes = await readBody(response.body, MAX_FETCH_BYTES)
    } catch (error) {
      throw new PluginCallRejected(
        error instanceof BodyTooLargeError
          ? '出站请求的响应体太大'
          : `读取出站响应失败（${error instanceof Error ? error.name : 'error'}）`,
      )
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      body: bytes,
    }
  }
}
