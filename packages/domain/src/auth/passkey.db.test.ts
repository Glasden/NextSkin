import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { coreMigrations, migrateToLatest, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createAuth, type Auth } from './auth.ts'

// 通行密钥的注册走完 Better Auth 的整条路径，在四种数据库上确认 passkeys 表存得下规范允许的数据。
// 认证器的响应在这里现场构造（fmt: none 的 attestation），不依赖浏览器。

const ROOT = 'http://localhost:3000'
let database: TestDatabase<CoreDatabase>
let auth: Auth

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
  auth = createAuth({
    db: database.db,
    secretKey: 'test-only-secret-key-with-at-least-32-characters',
    siteUrl: ROOT,
    siteName: 'NextSkin',
    legacyPasswordSalt: () => Promise.resolve(''),
  })
})
afterAll(async () => database?.cleanup())

/** 构造一个 none attestation 的注册响应：ES256 公钥、指定长度的 credential ID */
function registrationResponse(challenge: string, credentialId: Buffer) {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ]),
  )
  const idLength = Buffer.alloc(2)
  idLength.writeUInt16BE(credentialId.length)
  const authenticatorData = Buffer.concat([
    createHash('sha256').update(new URL(ROOT).hostname).digest(),
    Buffer.from([0x45]), // UP | UV | AT
    Buffer.alloc(4), // signCount = 0
    Buffer.alloc(16), // AAGUID
    idLength,
    credentialId,
    cose,
  ])
  const attestationObject = isoCBOR.encode(
    new Map<string, string | Uint8Array | Map<string, never>>([
      ['fmt', 'none'],
      ['authData', new Uint8Array(authenticatorData)],
      ['attStmt', new Map<string, never>()],
    ]),
  )
  const id = credentialId.toString('base64url')
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      transports: ['internal'],
      clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ROOT })).toString(
        'base64url',
      ),
      attestationObject: Buffer.from(attestationObject).toString('base64url'),
    },
  }
}

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')

test.each([32, 1023])('注册 credential ID 为 %i 字节的通行密钥（1023 是 WebAuthn 允许的上限）', async (length) => {
  const signUp = await auth.api.signUpEmail({
    body: { email: `passkey-${length}@example.test`, name: 'Passkey', password: 'correct horse battery staple' },
    asResponse: true,
  })
  expect(signUp.status).toBe(200)
  const session = cookies(signUp)

  const options = await auth.handler(
    new Request(`${ROOT}/api/auth/passkey/generate-register-options`, { headers: { cookie: session } }),
  )
  expect(options.status).toBe(200)
  const { challenge } = (await options.json()) as { challenge: string }
  const credentialId = randomBytes(length)
  const response = await auth.handler(
    new Request(`${ROOT}/api/auth/passkey/verify-registration`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${session}; ${cookies(options)}`, origin: ROOT },
      body: JSON.stringify({ response: registrationResponse(challenge, credentialId) }),
    }),
  )
  expect(response.status).toBe(200)
  const row = await database.db
    .selectFrom('passkeys')
    .select(['credential_id', 'counter'])
    .where('credential_id', '=', credentialId.toString('base64url'))
    .executeTakeFirstOrThrow()
  expect(row).toEqual({ credential_id: credentialId.toString('base64url'), counter: 0 })
})
