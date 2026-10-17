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
