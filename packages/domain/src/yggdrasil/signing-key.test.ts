import { generateKeyPair, verify } from 'node:crypto'
import { promisify } from 'node:util'
import { beforeAll, expect, test } from 'vitest'
import type { createSettingQueries } from '../settings/queries.ts'
import { createSigningKeyQuery, parseSigningKey } from './signing-key.ts'

const generate = promisify(generateKeyPair)
let pkcs8: string
let pkcs1: string
let publicKey: string
let small: string
let ec: string

beforeAll(async () => {
  const [rsa, weak, other] = await Promise.all([
    generate('rsa', { modulusLength: 4096 }),
    generate('rsa', { modulusLength: 2048 }),
    generate('ec', { namedCurve: 'prime256v1' }),
  ])
  pkcs8 = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  pkcs1 = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  publicKey = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  small = weak.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  ec = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}, 60_000)

test('PKCS#8 和 PKCS#1 都导出 SPKI 公钥，SHA1withRSA 按 UTF-8 签名', () => {
  for (const pem of [pkcs8, pkcs1]) {
    const key = parseSigningKey(pem)
    expect(key !== null).toBe(true)
    expect(key?.publicKey === publicKey).toBe(true)
    expect(key?.publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true)
    expect(key?.publicKey.endsWith('-----END PUBLIC KEY-----\n')).toBe(true)
    const value = 'textures 测试/UTF-8'
    const signature = key!.sign(value)
    expect(verify('RSA-SHA1', Buffer.from(value, 'utf8'), publicKey, Buffer.from(signature, 'base64'))).toBe(true)
    expect(verify('RSA-SHA1', Buffer.from(value + 'x', 'utf8'), publicKey, Buffer.from(signature, 'base64'))).toBe(
      false,
    )
  }
})

test('未配置、无法解析、非 RSA、少于 4096 位的密钥不可用', () => {
  for (const pem of [null, '', 'bad-private-key', ec, small]) expect(parseSigningKey(pem)).toBeNull()
})

test('同一 PEM 复用解析结果；设置变更后刷新缓存，也缓存不可用结果', async () => {
  let pem: string | null = pkcs8
  const settings = {
    read: () => Promise.resolve({ 'yggdrasil.signingKey': pem }),
  } as ReturnType<typeof createSettingQueries>
  const getSigningKey = createSigningKeyQuery(settings)
  const first = await getSigningKey()
  expect(first !== null).toBe(true)
  expect((await getSigningKey()) === first).toBe(true)
  pem = small
  expect(await getSigningKey()).toBeNull()
  expect(await getSigningKey()).toBeNull()
  pem = pkcs1
  const next = await getSigningKey()
  expect(next !== null).toBe(true)
  expect(next === first).toBe(false)
  expect(next?.publicKey === publicKey).toBe(true)
  pem = null
  expect(await getSigningKey()).toBeNull()
})
