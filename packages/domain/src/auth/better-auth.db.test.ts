import { captureLogs } from '@nextskin/logging'
import { markSiteInitialized } from '../setup/initialized.test-helper.ts'
import { coreMigrations, migrateToLatest, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createCore, type Core } from '../core.ts'
import { createAuth, redactLogMessage, type Auth } from './auth.ts'

// 直接对 Better Auth 实例的测试：只能在服务端调用的端点，以及测试环境下默认关掉的检查。
// 经过 HTTP 入口的行为见 auth.db.test.ts。

const ROOT = 'http://localhost:3000'
let database: TestDatabase<CoreDatabase>
let auth: Auth
let core: Core

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
  await markSiteInitialized(database.db)
  core = createCore({
    db: database.db,
    secretKey: 'test-only-secret-key-with-at-least-32-characters',
    production: false,
    textureStorage: {
      list: () => Promise.resolve([]),
      listTemp: () => Promise.resolve([]),
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
  })
  auth = createAuth({
    db: database.db,
    secretKey: 'test-only-secret-key-with-at-least-32-characters',
    siteUrl: ROOT,
    siteName: 'NextSkin',
    legacyPasswordSalt: () => Promise.resolve(''),
  })
})
afterAll(async () => database?.cleanup())

async function signUp(email: string, role: 'user' | 'admin') {
  const { uid } = await core.users.register({
    email,
    playerName: role === 'admin' ? 'ResourceAdmin' : 'ResourceUser',
    password: 'correct horse battery staple',
    ip: '127.0.0.1',
    locale: null,
  })
  await database.db.updateTable('users').set({ role }).where('id', '=', uid).execute()
  const response = await auth.api.signInEmail({
    body: { email, password: 'correct horse battery staple' },
    asResponse: true,
  })
  expect(response.status).toBe(200)
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  return new Headers({ cookie })
}

test('OAuth 资源的管理端点对所有身份关闭', async () => {
  const user = await signUp('resource-user@example.test', 'user')
  const admin = await signUp('resource-admin@example.test', 'admin')
  const body = { identifier: 'https://api.example.test/', name: 'Example API' }
  await expect(auth.api.adminCreateOAuthResource({ headers: user, body })).rejects.toThrow()
  await expect(auth.api.adminListOAuthResources({ headers: user })).rejects.toThrow()
  expect(await database.db.selectFrom('oauth_resources').select('id').execute()).toEqual([])
  await expect(auth.api.adminCreateOAuthResource({ headers: admin, body })).rejects.toThrow()
  await expect(auth.api.adminListOAuthResources({ headers: admin })).rejects.toThrow()
  expect(await database.db.selectFrom('oauth_resources').select('id').execute()).toEqual([])
})

test('日志里的 URL 去掉查询串和片段', () => {
  expect(redactLogMessage('Invalid callbackURL: https://evil.example/cb?access_token=abc#frag x')).toBe(
    'Invalid callbackURL: https://evil.example/cb?[redacted] x',
  )
  expect(redactLogMessage('see https://evil.example/#token=abc')).toBe('see https://evil.example/#[redacted]')
  expect(redactLogMessage('Invalid origin: https://evil.example')).toBe('Invalid origin: https://evil.example')
  expect(redactLogMessage('What happened? Nothing.')).toBe('What happened? Nothing.')
})

test('被拒绝的 callbackURL 写进日志时不带查询串里的令牌（不变量 11）', async () => {
  const context = await auth.$context
  // NODE_ENV=test 时 Better Auth 默认跳过 Origin 和回调地址检查，这里打开
  const skipped = context.skipOriginCheck
  context.skipOriginCheck = false
  const logs = captureLogs()
  try {
    const response = await auth.handler(
      new Request(`${ROOT}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ROOT },
        body: JSON.stringify({
          email: 'nobody@example.test',
          password: 'whatever password',
          callbackURL: 'https://untrusted.example.test/callback?access_token=LOG_CANARY',
        }),
      }),
    )
    expect(response.status).toBe(403)
  } finally {
    logs.restore()
    context.skipOriginCheck = skipped
  }
  expect(logs.records.some((record) => record.msg.includes('untrusted.example.test'))).toBe(true)
  expect(JSON.stringify(logs.records)).not.toContain('LOG_CANARY')
})
