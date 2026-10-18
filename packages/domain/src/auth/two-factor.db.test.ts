import { markSiteInitialized } from '../setup/initialized.test-helper.ts'
import {
  coreMigrations,
  migrateToLatest,
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  upsert,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createCore, encodeSettingValue, type Core, type CoreSettingKey, type CoreSettingValue } from '../index.ts'
import { isLegacyPasswordHash } from './legacy-passwords.ts'
import { Browser, ROOT, totp } from './security.test-helper.ts'

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const password = 'correct horse battery staple'
const email = 'security@example.test'
let database: TestDatabase<CoreDatabase>
let core: Core
let uid: number
const db = () => database.db
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
  await markSiteInitialized(db())
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db().deleteFrom('users').execute()
  await db().deleteFrom('jobs').execute()
  await db().deleteFrom('settings').execute()
  await db().deleteFrom('verifications').execute()
  core = createCore({
    db: db(),
    secretKey,
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
    mailTransport: { send: () => Promise.resolve({ messageId: null }) },
  })
  uid = (await core.users.register({ email, password, playerName: 'Security', ip: '127.0.0.1', locale: 'en' })).uid
  core.events.subscribe('user.profileUpdated', 'test:password', { run: () => Promise.resolve() })
})
async function setting<K extends CoreSettingKey>(key: K, value: CoreSettingValue<K>) {
  await upsert(db(), 'settings', {
    values: {
      namespace: 'core',
      key,
      value: encodeSettingValue(key, value, { secretKey }),
      updated_at: toIsoTimestamp(new Date()),
    },
    conflict: ['namespace', 'key'],
    update: ['value', 'updated_at'],
  })
}
async function login(value = password, root = ROOT) {
  const browser = new Browser(core, root)
  const response = await browser.request('/api/auth/sign-in/email', { email, password: value })
  expect(response.status).toBe(200)
  return { browser, response }
}
async function enable() {
  const { browser } = await login()
  const wrong = await browser.request('/api/auth/two-factor/enable', { password: 'wrong-password' })
  expect(wrong.status).toBe(400)
  const response = await browser.request('/api/auth/two-factor/enable', { password })
  expect(response.status).toBe(200)
  const result = (await response.json()) as { totpURI: string; backupCodes: string[] }
  const secret = new URL(result.totpURI).searchParams.get('secret')!
  expect(
    readAuthBoolean(
      (await db().selectFrom('users').select('two_factor_enabled').where('id', '=', uid).executeTakeFirstOrThrow())
        .two_factor_enabled ?? false,
    ),
  ).toBe(false)
  expect((await browser.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })).status).toBe(200)
  expect(
    readAuthBoolean(
      (await db().selectFrom('users').select('two_factor_enabled').where('id', '=', uid).executeTakeFirstOrThrow())
        .two_factor_enabled,
    ),
  ).toBe(true)
  return { browser, secret, backupCodes: result.backupCodes }
}
const passwordEvents = async () =>
  (await db().selectFrom('jobs').select('payload').where('name', '=', 'test:password').execute()).map(
    (row) => JSON.parse(row.payload) as unknown,
  )

test('启用 TOTP；密码登录仅返回挑战；完成后得到会话，同一挑战 Cookie 重放失败', async () => {
  const { browser, secret } = await enable()
  await setting('site.url', ROOT)
  expect(await core.auth.security(uid)).toMatchObject({ twoFactorEnabled: true, backupCodesRemaining: 10 })
  expect((await browser.request('/api/auth/sign-out', {})).status).toBe(200)
  const signed = await browser.request('/api/auth/sign-in/email', { email, password })
  expect(signed.status).toBe(200)
  expect(await signed.json()).toMatchObject({ twoFactorRedirect: true })
  expect(await browser.session()).toBeNull()
  expect(signed.headers.getSetCookie().filter((c) => c.includes('session_token=') && !/max-age=0/i.test(c))).toEqual([])
  const replay = new Browser(core)
  for (const [k, v] of browser.jar) replay.jar.set(k, v)
  const verified = await browser.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })
  expect(verified.status).toBe(200)
  expect(await browser.session()).toMatchObject({ uid })
  expect((await replay.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })).status).toBe(401)
  expect(await replay.session()).toBeNull()
})

test('两个各自通过密码的浏览器并发使用同一备用码，只成功一次，数量减一', async () => {
  const { backupCodes } = await enable()
  await setting('site.url', ROOT)
  const a = await login(),
    b = await login()
  expect(await a.response.json()).toMatchObject({ twoFactorRedirect: true })
  expect(await b.response.json()).toMatchObject({ twoFactorRedirect: true })
  const responses = await Promise.all(
    [a.browser, b.browser].map((browser) =>
      browser.request('/api/auth/two-factor/verify-backup-code', { code: backupCodes[0] }),
    ),
  )
  expect(responses.filter((r) => r.status === 200)).toHaveLength(1)
  expect(responses.filter((r) => r.status >= 400 && r.status < 500)).toHaveLength(1)
  expect((await Promise.all([a.browser.session(), b.browser.session()])).filter(Boolean)).toHaveLength(1)
  expect((await core.auth.security(uid)).backupCodesRemaining).toBe(9)
})

test('每个挑战最多五次，跨挑战连续失败十次后账号锁十五分钟，正确 TOTP 也拒绝', async () => {
  const { secret } = await enable()
  const invalid = totp(secret) === '000000' ? '000001' : '000000'
  for (let challenge = 0; challenge < 2; challenge++) {
    const { browser } = await login()
    for (let i = 0; i < 5; i++)
      expect((await browser.request('/api/auth/two-factor/verify-totp', { code: invalid })).status).toBe(401)
    if (challenge === 0) {
      const exhausted = await browser.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })
      expect(exhausted.status).toBe(400)
      expect(await exhausted.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' })
    }
  }
  const row = await db()
    .selectFrom('two_factors')
    .select(['failed_verification_count', 'locked_until'])
    .where('user_id', '=', uid)
    .executeTakeFirstOrThrow()
  expect(row.failed_verification_count).toBe(10)
  const remaining = new Date(readAuthDate(row.locked_until)).getTime() - Date.now()
  expect(remaining).toBeGreaterThan(890_000)
  expect(remaining).toBeLessThanOrEqual(900_000)
  const { browser } = await login()
  const response = await browser.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })
  expect(response.status).toBe(429)
  expect(await response.json()).toMatchObject({ code: 'ACCOUNT_TEMPORARILY_LOCKED' })
  expect(await browser.session()).toBeNull()
})

test('改密码撤销其他会话，当前浏览器继续登录；事务提交后发 password 事件', async () => {
  const { browser } = await login()
  const other = (await login()).browser
  const response = await browser.request('/api/auth/change-password', {
    currentPassword: password,
    newPassword: 'new correct password',
    revokeOtherSessions: true,
  })
  expect(response.status).toBe(200)
  expect(await browser.session()).toMatchObject({ uid })
  expect(await other.session()).toBeNull()
  expect(await passwordEvents()).toMatchObject([
    { name: 'user.profileUpdated', actor: { kind: 'user', uid, role: 'user' }, data: { uid, fields: ['password'] } },
  ])
  expect((await new Browser(core).request('/api/auth/sign-in/email', { email, password })).status).toBe(401)
  expect((await login('new correct password')).response.status).toBe(200)
})

test('旧密码登录重新哈希不发 password 事件；密码错误和新密码不合法也不发', async () => {
  await db()
    .updateTable('accounts')
    .set({ password: '$bs$salted2sha256$a99c25c7b8f53925aedf19fe78ccd0838ecb44f54baa455289c36798a80b07eb' })
    .where('user_id', '=', uid)
    .execute()
  await setting('auth.legacyPasswordSalt', 'bs-salt-中文')
  const { browser } = await login('php-era-password')
  const account = await db()
    .selectFrom('accounts')
    .select('password')
    .where('user_id', '=', uid)
    .executeTakeFirstOrThrow()
  expect(isLegacyPasswordHash(account.password!)).toBe(false)
  for (const body of [
    { currentPassword: 'wrong', newPassword: 'new correct password' },
    { currentPassword: 'php-era-password', newPassword: 'short' },
  ])
    expect((await browser.request('/api/auth/change-password', body)).status).toBe(400)
  expect(await passwordEvents()).toEqual([])
})

async function resetPassword(newPassword: string) {
  await setting('site.url', ROOT)
  await setting('mail.transport', 'smtp')
  await setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
  const browser = new Browser(core)
  const requested = await browser.request('/api/auth/request-password-reset', {
    email,
    redirectTo: `${ROOT}/reset-password`,
  })
  expect(requested.status).toBe(200)
  const job = await db()
    .selectFrom('jobs')
    .select('payload')
    .where('name', '=', 'core:mail')
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow()
  const payload = JSON.parse(job.payload) as { url: string }
  const callback = await browser.request(payload.url)
  const token = new URL(callback.headers.get('location')!, ROOT).searchParams.get('token')!
  expect(token).toBeTruthy()
  const response = await browser.request('/api/auth/reset-password', { token, newPassword })
  expect(response.status).toBe(200)
  return token
}

test('邮件找回密码后发 password 事件、撤销会话，重新登录仍要两步验证', async () => {
  const { browser, secret } = await enable()
  const token = await resetPassword('new correct password')
  expect(await browser.session()).toBeNull()
  expect(await passwordEvents()).toMatchObject([{ data: { uid, fields: ['password'] } }])
  expect(
    (await new Browser(core).request('/api/auth/reset-password', { token, newPassword: 'another correct password' }))
      .status,
  ).toBe(400)
  expect(await passwordEvents()).toHaveLength(1)
  const signed = await login('new correct password')
  expect(await signed.response.json()).toMatchObject({ twoFactorRedirect: true })
  expect(await signed.browser.session()).toBeNull()
  expect((await signed.browser.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })).status).toBe(200)
  expect(await signed.browser.session()).toMatchObject({ uid })
})

test('密码事件入队失败只记固定日志，不影响改密码或找回密码', async () => {
  const { browser } = await login()
  const enqueue = core.jobs.enqueue.bind(core.jobs)
  const spy = vi.spyOn(core.jobs, 'enqueue').mockImplementation((tx, name, payload, options) => {
    if (name === 'test:password') throw new Error('sensitive data must never be logged')
    return enqueue(tx, name, payload, options)
  })
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(
      (
        await browser.request('/api/auth/change-password', {
          currentPassword: password,
          newPassword: 'new correct password',
          revokeOtherSessions: true,
        })
      ).status,
    ).toBe(200)
    await resetPassword('reset correct password')
    expect(log.mock.calls).toEqual([['[auth] password_event_failed'], ['[auth] password_event_failed']])
    expect((await login('reset correct password')).response.status).toBe(200)
  } finally {
    spy.mockRestore()
    log.mockRestore()
  }
})

test('通行密钥注册要求会话十分钟内创建；旧会话 SESSION_NOT_FRESH', async () => {
  const { browser } = await login()
  const generated = () => browser.request('/api/auth/passkey/generate-register-options')
  await db()
    .updateTable('sessions')
    .set({ created_at: writeAuthDate(db(), toIsoTimestamp(new Date(Date.now() - 601_000))) })
    .where('user_id', '=', uid)
    .execute()
  const old = await generated()
  expect(old.status).toBe(403)
  expect(await old.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' })
  await db()
    .updateTable('sessions')
    .set({ created_at: writeAuthDate(db(), toIsoTimestamp(new Date(Date.now() - 300_000))) })
    .where('user_id', '=', uid)
    .execute()
  expect((await generated()).status).toBe(200)
})

test.each(['/change-email', '/delete-user'])('Better Auth %s 已关闭，由领域用例代替', async (path) => {
  const { browser } = await login()
  expect((await browser.request(`/api/auth${path}`, { password, newEmail: 'other@example.test' })).status).toBe(404)
  expect(await core.users.profile(uid)).toMatchObject({ email })
})

test.each([ROOT, 'https://skin.example.test'])('删除后清会话 Cookie 与 %s 的实际 Cookie 名和属性一致', async (root) => {
  await setting('site.url', root)
  const { browser, response } = await login(password, root)
  const original = response.headers.getSetCookie().find((c) => c.includes('session_token='))!
  expect(original).toBeTruthy()
  await core.users.deleteAccount({ uid }, { password })
  const cleared = await core.auth.clearSessionCookies(new Headers({ cookie: browser.cookieHeader() }), root)
  const expired = cleared.find((c) => c.startsWith(original.split('=')[0]! + '='))!
  expect(expired).toMatch(/Max-Age=0/i)
  for (const attribute of ['Path=/', 'HttpOnly', 'SameSite=Lax']) expect(expired).toContain(attribute)
  if (root.startsWith('https:')) {
    expect(expired).toMatch(/^__Secure-nextskin\.session_token=/)
    expect(expired).toContain('; Secure')
  } else expect(expired).toMatch(/^nextskin\.session_token=/)
  browser.applyCookies(cleared)
  expect([...browser.jar.keys()].some((name) => name.endsWith('.session_token'))).toBe(false)
  expect(await browser.session()).toBeNull()
})

test('同一两步验证挑战并发提交两次，只签发一个会话', async () => {
  const { secret } = await enable()
  const { browser, response } = await login()
  expect(await response.json()).toMatchObject({ twoFactorRedirect: true })
  const other = new Browser(core)
  for (const [name, value] of browser.jar) other.jar.set(name, value)
  const results = await Promise.all(
    [browser, other].map((b) => b.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })),
  )
  expect(results.map((r) => r.status).sort()).toEqual([200, 401])
  expect((await Promise.all([browser.session(), other.session()])).filter(Boolean)).toHaveLength(1)
})
