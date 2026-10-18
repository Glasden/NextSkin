// 比对规则本身的测试：错误的实现必须被发现，不能因为规则太宽而通过。
import { createPrivateKey, sign } from 'node:crypto'
import { expect, test } from 'vitest'
import { compareResponse, type CompareContext } from './compare.ts'
import type { RecordedResponse } from './recording.ts'
import { generateSigningKey } from './seed.ts'

const keys = generateSigningKey()
const other = generateSigningKey()
const now = Date.now()
const context: CompareContext = { publicKey: keys.publicKey, timeWindow: { from: now - 1000, to: now + 1000 } }

const png: RecordedResponse = {
  status: 200,
  headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400, public', etag: '"abc"' },
  body: { kind: 'binary', sha256: 'f'.repeat(64), size: 10 },
}

test('相同的响应没有差异', () => {
  expect(compareResponse(png, structuredClone(png), 'exact', context)).toEqual([])
})

test.each([
  ['多了 Content-Encoding', { headers: { ...png.headers, 'content-encoding': 'gzip' } }],
  ['缺少 ETag', { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400, public' } }],
  ['Cache-Control 不同', { headers: { ...png.headers, 'cache-control': 'no-cache, private' } }],
  ['状态码不同', { status: 404 }],
  ['字节不同', { body: { kind: 'binary', sha256: '0'.repeat(64), size: 10 } }],
  ['响应体类型不同', { body: { kind: 'empty' } }],
] as const)('%s 时报告差异', (_, change) => {
  expect(compareResponse(png, { ...png, ...change }, 'exact', context)).not.toEqual([])
})

const errorPage: RecordedResponse = {
  status: 404,
  headers: { 'content-type': 'text/html; charset=UTF-8', 'cache-control': 'no-cache, private', etag: '"x"' },
  body: { kind: 'html', size: 900 },
}

test('HTML 错误页只比较状态码和其余响应头', () => {
  const actual: RecordedResponse = {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=UTF-8', 'cache-control': 'no-cache, private' },
    body: { kind: 'text', value: 'Not Found' },
  }
  expect(compareResponse(errorPage, actual, 'exact', context)).toEqual([])
  // HEAD 的错误响应没有响应体，仍按错误页处理
  const head = { ...errorPage, body: { kind: 'empty' as const } }
  expect(compareResponse(head, { ...actual, body: { kind: 'empty' } }, 'exact', context)).toEqual([])
  expect(compareResponse(errorPage, { ...actual, status: 403 }, 'exact', context)).not.toEqual([])
  expect(
    compareResponse(
      errorPage,
      { ...actual, headers: { ...actual.headers, 'cache-control': 'public' } },
      'exact',
      context,
    ),
  ).not.toEqual([])
})

function meta(publicKey: string): RecordedResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      kind: 'json',
      value: {
        meta: { serverName: 'x', implementationName: 'BS', implementationVersion: '5.2.1' },
        skinDomains: ['a'],
        signaturePublickey: publicKey,
      },
    },
  }
}

test('元数据公布的公钥必须是签名用的那把', () => {
  expect(compareResponse(meta(other.publicKey), meta(keys.publicKey), 'yggdrasil-meta', context)).toEqual([])
  expect(compareResponse(meta(other.publicKey), meta(other.publicKey), 'yggdrasil-meta', context)).not.toEqual([])
})

function profile(timestamp: number, signer: string | undefined): RecordedResponse {
  const value = Buffer.from(JSON.stringify({ timestamp, profileName: 'Steve', textures: {} })).toString('base64')
  const property: Record<string, string> = { name: 'textures', value }
  if (signer) property.signature = sign('sha1', Buffer.from(value), createPrivateKey(signer)).toString('base64')
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { kind: 'json', value: { id: 'u', name: 'Steve', properties: [property] } },
  }
}

test('profile 的签名用 NextSkin 的公钥验证，时间戳要落在回放期间', () => {
  const recorded = profile(1, other.privateKey)
  expect(compareResponse(recorded, profile(now, keys.privateKey), 'yggdrasil-profile', context)).toEqual([])
  expect(compareResponse(recorded, profile(now, other.privateKey), 'yggdrasil-profile', context)).not.toEqual([])
  expect(compareResponse(recorded, profile(now, undefined), 'yggdrasil-profile', context)).not.toEqual([])
  expect(compareResponse(recorded, profile(now - 60_000, keys.privateKey), 'yggdrasil-profile', context)).not.toEqual(
    [],
  )
})

function token(accessToken: string, clientToken: string, extra: Record<string, unknown> = {}): RecordedResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { kind: 'json', value: { accessToken, clientToken, availableProfiles: [], ...extra } },
  }
}

test('令牌不比较值，但同一个场景里不能重复；请求给了 clientToken 才逐字比较', () => {
  const step = (requestBody: unknown) => ({ ...context, scenario: { seenAccessTokens, clientTokens, requestBody } })
  const seenAccessTokens = new Set<string>()
  const clientTokens = new Map<string, string>()
  const recorded = token('jwt.from.bs', 'given')
  expect(
    compareResponse(recorded, token('a'.repeat(32), 'given'), 'yggdrasil-token', step({ clientToken: 'given' })),
  ).toEqual([])
  // 同一个令牌在场景里第二次出现
  expect(
    compareResponse(recorded, token('a'.repeat(32), 'given'), 'yggdrasil-token', step({ clientToken: 'given' })),
  ).not.toEqual([])
  expect(
    compareResponse(recorded, token('b'.repeat(32), 'other'), 'yggdrasil-token', step({ clientToken: 'given' })),
  ).not.toEqual([])
  // 没给 clientToken：服务端生成的只要求非空
  const generated = token('jwt.from.bs', 'bs-generated')
  expect(compareResponse(generated, token('c'.repeat(32), 'ns-generated'), 'yggdrasil-token', step({}))).toEqual([])
  expect(compareResponse(generated, token('d'.repeat(32), ''), 'yggdrasil-token', step({}))).not.toEqual([])
  expect(compareResponse(generated, token('', 'x'), 'yggdrasil-token', step({}))).not.toEqual([])
  // 其余字段深比较
  expect(
    compareResponse(
      generated,
      token('e'.repeat(32), 'x', { user: { id: 'u', properties: [] } }),
      'yggdrasil-token',
      step({}),
    ),
  ).not.toEqual([])
  expect(() => compareResponse(recorded, token('f'.repeat(32), 'given'), 'yggdrasil-token', context)).not.toThrow()
  expect(compareResponse(recorded, token('f'.repeat(32), 'given'), 'yggdrasil-token', context)).not.toEqual([])
})

test('BS 在这一步返回错误时按 yggdrasil-error 比较', () => {
  const error: RecordedResponse = {
    status: 403,
    headers: { 'content-type': 'application/json' },
    body: { kind: 'json', value: { error: 'ForbiddenOperationException', errorMessage: 'BS' } },
  }
  const actual = structuredClone(error)
  if (actual.body.kind === 'json') actual.body.value = { error: 'ForbiddenOperationException', errorMessage: 'NS' }
  expect(compareResponse(error, actual, 'yggdrasil-token', context)).toEqual([])
})

test('没给 clientToken 时，录制结果里同一个值在回放时也要是同一个（refresh 沿用）', () => {
  const seenAccessTokens = new Set<string>()
  const clientTokens = new Map<string, string>()
  const step = (requestBody: unknown) => ({ ...context, scenario: { seenAccessTokens, clientTokens, requestBody } })
  // 登录时给了 clientToken，refresh 不给：必须原样沿用
  expect(
    compareResponse(
      token('a', 'original'),
      token('1', 'original'),
      'yggdrasil-token',
      step({ clientToken: 'original' }),
    ),
  ).toEqual([])
  expect(compareResponse(token('b', 'original'), token('2', 'rotated'), 'yggdrasil-token', step({}))).not.toEqual([])
  expect(compareResponse(token('c', 'original'), token('3', 'original'), 'yggdrasil-token', step({}))).toEqual([])
  // 服务端生成的 clientToken：两边的值不同，但之后要一直对应
  expect(compareResponse(token('d', 'bs-generated'), token('4', 'ns-generated'), 'yggdrasil-token', step({}))).toEqual(
    [],
  )
  expect(compareResponse(token('e', 'bs-generated'), token('5', 'ns-other'), 'yggdrasil-token', step({}))).not.toEqual(
    [],
  )
  expect(compareResponse(token('f', 'bs-generated'), token('6', 'ns-generated'), 'yggdrasil-token', step({}))).toEqual(
    [],
  )
})
