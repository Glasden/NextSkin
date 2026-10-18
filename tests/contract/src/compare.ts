// 把 NextSkin 的响应和 BS 的录制结果比较。规则的理由见 README.md。
import { isDeepStrictEqual } from 'node:util'
import type { BodyMatch } from './cases.ts'
import type { RecordedResponse } from './recording.ts'
import { assertSigningPublicKey, decodeTexturesValue, verifyPropertySignature } from './yggdrasil.ts'

/**
 * 逐个比较的响应头：影响客户端解码、缓存和发现 API 的头。其余响应头（Content-Length、Date、
 * Set-Cookie、Next 加的 Vary 等）属于传输层或不复现，不比较。
 */
export const COMPARED_HEADERS = [
  'content-type',
  'content-encoding',
  'cache-control',
  'etag',
  'last-modified',
  'x-authlib-injector-api-location',
  'allow',
  'location',
] as const

/** BS 渲染 Laravel 的 HTML 错误页时，这几个响应头取决于页面本身，不比较。 */
const ERROR_PAGE_IGNORED = new Set(['content-type', 'etag'])

export interface CompareContext {
  /** NextSkin 签名用的公钥（SPKI PEM）。元数据公布的公钥必须就是它 */
  publicKey: string
  /** textures 属性里的 timestamp 必须落在这个区间内（毫秒） */
  timeWindow: { from: number; to: number }
  /**
   * 场景里的一步：`yggdrasil-token` 要用到之前出现过的令牌、这一步的请求体，
   * 以及录制结果里的 clientToken 对应回放时的哪个值（服务端生成的 clientToken 两边不同）
   */
  scenario?: { seenAccessTokens: Set<string>; clientTokens: Map<string, string>; requestBody: unknown }
}

export function compareResponse(
  expected: RecordedResponse,
  actual: RecordedResponse,
  match: BodyMatch,
  context: CompareContext,
): string[] {
  const problems: string[] = []
  if (actual.status !== expected.status) problems.push(`状态码：期望 ${expected.status}，实际 ${actual.status}`)
  // 用状态码和 Content-Type 判断，不看响应体：HEAD 的错误响应没有响应体
  const errorPage = expected.status >= 400 && (expected.headers['content-type'] ?? '').startsWith('text/html')
  for (const header of COMPARED_HEADERS) {
    if (errorPage && ERROR_PAGE_IGNORED.has(header)) continue
    if (actual.headers[header] !== expected.headers[header]) {
      problems.push(`响应头 ${header}：期望 ${show(expected.headers[header])}，实际 ${show(actual.headers[header])}`)
    }
  }
  if (errorPage) {
    if (actual.body.kind === 'json' || actual.body.kind === 'binary') {
      problems.push(`响应体：BS 返回错误页，NextSkin 却返回了 ${actual.body.kind}`)
    }
    return problems
  }
  if (actual.body.kind !== expected.body.kind) {
    problems.push(`响应体类型：期望 ${expected.body.kind}，实际 ${actual.body.kind}`)
    return problems
  }
  if (expected.body.kind === 'binary' && actual.body.kind === 'binary') {
    if (actual.body.sha256 !== expected.body.sha256) problems.push('响应体：文件字节不同')
  } else if (expected.body.kind === 'text' && actual.body.kind === 'text') {
    if (actual.body.value !== expected.body.value)
      problems.push(`响应体：期望 ${show(expected.body.value)}，实际 ${show(actual.body.value)}`)
  } else if (expected.body.kind === 'json' && actual.body.kind === 'json') {
    let normalized: { expected: unknown; actual: unknown }
    try {
      normalized = normalizeJson(expected.body.value, actual.body.value, match, context)
    } catch (error) {
      problems.push(`响应体：${(error as Error).message}`)
      return problems
    }
    if (!isDeepStrictEqual(normalized.actual, normalized.expected)) {
      problems.push(
        `响应体：\n  期望 ${JSON.stringify(normalized.expected)}\n  实际 ${JSON.stringify(normalized.actual)}`,
      )
    }
  }
  return problems
}

function show(value: string | undefined): string {
  return value === undefined ? '（没有）' : JSON.stringify(value)
}

/** 把不能逐字比较的字段换成占位符；实际响应里的这些字段先按规则检查。 */
function normalizeJson(
  expected: unknown,
  actual: unknown,
  match: BodyMatch,
  context: CompareContext,
): { expected: unknown; actual: unknown } {
  if (match === 'exact') return { expected, actual }
  const e = asObject(structuredClone(expected))
  const a = asObject(structuredClone(actual))
  // 录制时 BS 拒绝了这一步（例如节流），就按错误比较
  const kind = match === 'yggdrasil-token' && !('accessToken' in e) ? 'yggdrasil-error' : match
  if (kind === 'yggdrasil-token') {
    requireString(a, 'accessToken')
    const seen = context.scenario?.seenAccessTokens
    if (!seen) throw new Error('yggdrasil-token 只能用于场景')
    if (seen.has(a.accessToken as string)) throw new Error('accessToken 与这个场景里之前出现过的令牌相同')
    seen.add(a.accessToken as string)
    e.accessToken = a.accessToken = '<accessToken>'
    const body = context.scenario?.requestBody
    const requested = body && typeof body === 'object' ? (body as Record<string, unknown>).clientToken : undefined
    // 请求里给了 clientToken 就逐字比较（它和录制结果都要等于 trim 之后的值）。没给时由服务端生成或沿用：
    // 第一次出现的只要求非空，记下两边的对应关系；录制结果里再出现同一个值时，回放必须还是对应的那个
    requireString(a, 'clientToken')
    const clientTokens = context.scenario!.clientTokens
    if (typeof requested !== 'string' && typeof e.clientToken === 'string') {
      const mapped = clientTokens.get(e.clientToken)
      if (mapped !== undefined && mapped !== a.clientToken)
        throw new Error(`clientToken 应当沿用 ${JSON.stringify(mapped)}，实际是 ${JSON.stringify(a.clientToken)}`)
      clientTokens.set(e.clientToken, a.clientToken as string)
      e.clientToken = a.clientToken = '<clientToken>'
    } else if (typeof e.clientToken === 'string') clientTokens.set(e.clientToken, a.clientToken as string)
  } else if (kind === 'yggdrasil-error') {
    requireString(a, 'errorMessage')
    e.errorMessage = a.errorMessage = '<errorMessage>'
  } else if (kind === 'yggdrasil-meta') {
    assertSigningPublicKey(a.signaturePublickey)
    // 公布的公钥必须能验证签名，否则客户端验签失败
    if (a.signaturePublickey !== context.publicKey) throw new Error('signaturePublickey 不是签名用的那把公钥')
    e.signaturePublickey = a.signaturePublickey = '<public key>'
    const expectedMeta = asObject(e.meta)
    const actualMeta = asObject(a.meta)
    for (const key of ['implementationName', 'implementationVersion']) {
      requireString(actualMeta, key)
      expectedMeta[key] = actualMeta[key] = '<string>'
    }
  } else if (kind === 'yggdrasil-profile') {
    e.properties = normalizeProperties(e.properties, undefined)
    a.properties = normalizeProperties(a.properties, context)
  }
  return { expected: e, actual: a }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`应当是 JSON 对象：${JSON.stringify(value)}`)
  return value as Record<string, unknown>
}

function requireString(object: Record<string, unknown>, key: string): void {
  if (typeof object[key] !== 'string' || object[key] === '')
    throw new Error(`${key} 必须是非空字符串，实际是 ${JSON.stringify(object[key])}`)
}

/** context 为空表示录制结果：签名在录制时已经用 BS 的公钥验证过。 */
function normalizeProperties(properties: unknown, context: CompareContext | undefined): unknown {
  if (!Array.isArray(properties)) return properties
  return properties.map((item: unknown) => {
    const property = asObject(item)
    const result: Record<string, unknown> = { ...property }
    if (typeof property.value === 'string' && property.name === 'textures') {
      const textures = decodeTexturesValue(property.value)
      if (context) {
        const timestamp = textures.timestamp
        if (typeof timestamp !== 'number' || timestamp < context.timeWindow.from || timestamp > context.timeWindow.to) {
          throw new Error(`textures 属性的 timestamp 不是回放期间的毫秒时间：${JSON.stringify(timestamp)}`)
        }
      }
      textures.timestamp = '<timestamp>'
      result.value = textures
    }
    if (property.signature !== undefined) {
      if (context) {
        if (typeof property.signature !== 'string' || typeof property.value !== 'string') {
          throw new Error(`属性 ${String(property.name)} 的签名格式不对`)
        }
        if (!verifyPropertySignature(property.value, property.signature, context.publicKey)) {
          throw new Error(`属性 ${String(property.name)} 的签名用 NextSkin 的公钥验证不通过`)
        }
      }
      result.signature = '<valid signature>'
    }
    return result
  })
}
