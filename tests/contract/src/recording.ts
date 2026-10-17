// 录制结果的格式。录制脚本和回放测试共用，响应体按同一套规则归类，两边才能比较。
import { createHash } from 'node:crypto'

export type RecordedBody =
  | { kind: 'empty' }
  | { kind: 'json'; value: unknown }
  | { kind: 'binary'; sha256: string; size: number }
  /** BS 渲染的 HTML 错误页，不属于协议，只记大小 */
  | { kind: 'html'; size: number }
  | { kind: 'text'; value: string }

export interface RecordedResponse {
  status: number
  /** 名字小写；不含 VOLATILE_HEADERS */
  headers: Record<string, string>
  body: RecordedBody
}

export interface Recording {
  source: { bs: string; plugins: Record<string, string>; recordedAt: string }
  cases: Record<string, RecordedResponse>
}

/** 每次请求都会变、或属于传输层的响应头，录制时就丢掉。 */
export const VOLATILE_HEADERS = new Set([
  'date',
  'server',
  'x-powered-by',
  'connection',
  'keep-alive',
  'transfer-encoding',
  // BS 每个响应都写语言 Cookie（DetectLanguagePrefer），带过期时间，NextSkin 不写
  'set-cookie',
])

export function recordHeaders(entries: Iterable<[string, string]>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of entries) {
    const key = name.toLowerCase()
    if (!VOLATILE_HEADERS.has(key)) headers[key] = value
  }
  return Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)))
}

export function recordBody(contentType: string | undefined, bytes: Uint8Array): RecordedBody {
  if (bytes.length === 0) return { kind: 'empty' }
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (type === 'application/json') {
    const text = Buffer.from(bytes).toString('utf8')
    try {
      return { kind: 'json', value: JSON.parse(text) }
    } catch {
      return { kind: 'text', value: text }
    }
  }
  if (type.startsWith('image/')) {
    return { kind: 'binary', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
  }
  if (type === 'text/html') return { kind: 'html', size: bytes.length }
  return { kind: 'text', value: Buffer.from(bytes).toString('utf8') }
}
