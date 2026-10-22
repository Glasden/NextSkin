import { expect, test } from 'vitest'
import { contentSecurityPolicy, createNonce } from './csp'

test('nonce 是 16 字节的 base64，每次不同', () => {
  const nonces = Array.from({ length: 100 }, createNonce)
  for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
  expect(new Set(nonces).size).toBe(nonces.length)
})

test('只约束脚本、插件对象、<base>、表单和被嵌入；开发模式多 unsafe-eval', () => {
  expect(contentSecurityPolicy('abc', false)).toBe(
    "script-src 'nonce-abc' 'strict-dynamic'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  )
  expect(contentSecurityPolicy('abc', true)).toBe(
    "script-src 'nonce-abc' 'strict-dynamic' 'unsafe-eval'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  )
})
