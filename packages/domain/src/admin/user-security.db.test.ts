import { seedOAuth } from '../oauth/oauth.test-helper.ts'
import { createHash } from 'node:crypto'
import { markSiteInitialized } from '../setup/initialized.test-helper.ts'
import {
  coreMigrations,
  countRows,
  insertReturningId,
  migrateToLatest,
  readAuthBoolean,
  toIsoTimestamp,
  upsert,
  writeAuthDate,
  type CoreDatabase,
  type UserRole,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { definePlugin } from '@nextskin/plugin-sdk'
import { hashPassword } from 'better-auth/crypto'
import type { KyselyPlugin, QueryId } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { Browser, ROOT, totp } from '../auth/security.test-helper.ts'
import type { RevokedLogins } from '../auth/revoke.ts'
import { pauseNextCommit } from '../commit-pause.test-helper.ts'
import { createCore, encodeSettingValue, type Core, type CoreSettingKey, type CoreSettingValue } from '../index.ts'
import { MAIL_JOB } from '../mail/service.ts'
import { official } from '../plugins/plugins.test-helper.ts'

// 后台的账号安全操作（ADR-0036"作废在途的登录"到"退出全部登录"、"命令行"）：改密码、收回账号、关两步验证、
// 删通行密钥、解绑、退出全部登录。每个"作废"都走真实的 Better Auth 流程验证到可观察的行为。
// 第三方绑定用两个进程内的官方插件：login 一直启用，other 按需停用，表示"插件停用了的绑定"

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const password = 'correct horse battery staple'
const fresh = 'issued by the administrator'
const siteUrl = 'https://skin.example.test'
const storage = {
  list: () => Promise.resolve([]),
  listTemp: () => Promise.resolve([]),
  lateDeleteWindowMs: 0,
  write: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  deleteTemp: () => Promise.resolve(),
  read: () => Promise.resolve(null),
}
const identity = { subject: 'subject', email: 'external@example.test', emailVerified: true, displayName: 'External' }
const exchange = vi.fn(() => Promise.resolve({ ...identity }))
const login = () =>
  definePlugin({
    capabilities: [],
    providers: {
      login: [
        {
          id: 'main',
          label: 'login.main',
          icon: 'github',
          authorizeUrl: () => Promise.resolve('https://identity.example.test/authorize'),
          exchange,
        },
      ],
    },
  })

let database: TestDatabase<CoreDatabase>
let core: Core
let hash: string
let root: { uid: number; ip: string | null }
let admin: { uid: number; ip: string | null }
let sequence = 0
const db = () => database.db

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
  await markSiteInitialized(db())
  hash = await hashPassword(password)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db().deleteFrom('device_codes').execute()
  await db().deleteFrom('users').execute()
  await db().deleteFrom('jobs').execute()
  await db().deleteFrom('settings').execute()
  await db().deleteFrom('verifications').execute()
  await db().deleteFrom('audit_logs').execute()
  exchange.mockClear()
  core = createCore({
    db: db(),
    secretKey,
    production: false,
    textureStorage: storage,
    mailTransport: { send: () => Promise.resolve({ messageId: null }) },
    plugins: { official: [official('login', login()), official('other', login())] },
  })
  await core.plugins.start()
  root = { uid: (await user('root', { role: 'superadmin' })).uid, ip: null }
  // 启用状态存在表里，上一个测试停用的 other 在这里重新启用
  for (const id of ['login', 'other']) await core.plugins.admin.enable(root, id)
  admin = { uid: (await user('admin', { role: 'admin' })).uid, ip: '192.0.2.1' }
  await setting('yggdrasil.loginIntervalMs', 0)
  core.events.subscribe('user.profileUpdated', 'test:profile', { run: () => Promise.resolve() })
})
afterEach(async () => core?.shutdown())

async function user(name: string, options: { role?: UserRole; password?: boolean } = {}) {
  const email = `${name}@example.test`
  const now = writeAuthDate(db(), toIsoTimestamp(new Date()))
  const uid = await insertReturningId(db(), 'users', {
    nickname: name,
    email,
    role: options.role ?? 'user',
    email_verified: true,
    locale: 'en',
    created_at: now,
    updated_at: now,
  })
  if (options.password !== false) await credential(uid, hash)
  return { uid, email }
}
function account(uid: number, providerId: string, accountId: string, value: string | null) {
  const now = writeAuthDate(db(), toIsoTimestamp(new Date()))
  return db()
    .insertInto('accounts')
    .values({
      user_id: uid,
      provider_id: providerId,
      account_id: accountId,
      password: value,
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      scope: null,
      created_at: now,
      updated_at: now,
    })
    .execute()
}
/** 密码那一行；value 为 null 时是"有这一行、没有密码"（导入时哈希认不出的账号） */
const credential = (uid: number, value: string | null) => account(uid, 'credential', String(uid), value)
const bind = (uid: number, pluginId: string) => account(uid, `plugin:${pluginId}:main`, `${pluginId}-${uid}`, null)
async function passkey(uid: number) {
  await db()
    .insertInto('passkeys')
    .values({
      user_id: uid,
      name: 'Key',
      public_key: 'test-key',
      credential_id: `key-${++sequence}`,
      counter: 0,
      device_type: 'multiDevice',
      backed_up: true,
      transports: null,
      created_at: writeAuthDate(db(), toIsoTimestamp(new Date())),
      aaguid: null,
    })
    .execute()
}
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
async function configureMail() {
  await setting('site.url', ROOT)
  await setting('mail.transport', 'smtp')
  await setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
}

const attempt = (email: string, value: string) =>
  new Browser(core).request('/api/auth/sign-in/email', { email, password: value })
async function signIn(email: string, value = password) {
  const browser = new Browser(core)
  expect((await browser.request('/api/auth/sign-in/email', { email, password: value })).status).toBe(200)
  return browser
}
/** 过了密码这一步、还没补第二步的浏览器：Better Auth 在 verifications 里写了挑战 */
async function challenge(email: string, value = password) {
  const browser = new Browser(core)
  const response = await browser.request('/api/auth/sign-in/email', { email, password: value })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ twoFactorRedirect: true })
  expect(await browser.session()).toBeNull()
  return browser
}
async function enableTwoFactor(browser: Browser, value = password) {
  const response = await browser.request('/api/auth/two-factor/enable', { password: value })
  expect(response.status).toBe(200)
  const { totpURI } = (await response.json()) as { totpURI: string }
  const secret = new URL(totpURI).searchParams.get('secret')!
  expect((await browser.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })).status).toBe(200)
  return secret
}
/** 只带着"信任这台设备"Cookie 的新浏览器 */
function carryTrust(from: Browser) {
  const device = new Browser(core)
  for (const [name, value] of from.jar) if (name.endsWith('.trust_device')) device.jar.set(name, value)
  expect(device.jar.size).toBe(1)
  return device
}
async function resetTokens(uid: number) {
  const rows = await db()
    .selectFrom('verifications')
    .select('identifier')
    .where('identifier', 'like', 'reset-password:%')
    .where('value', '=', String(uid))
    .execute()
  return rows.map((row) => row.identifier.slice('reset-password:'.length))
}
async function requestReset(email: string, uid: number) {
  const before = new Set(await resetTokens(uid))
  const response = await new Browser(core).request('/api/auth/request-password-reset', {
    email,
    redirectTo: `${ROOT}/reset-password`,
  })
  expect(response.status).toBe(200)
  const token = (await resetTokens(uid)).find((value) => !before.has(value))
  expect(token).toBeDefined()
  return token!
}
const reset = (token: string) =>
  new Browser(core).request('/api/auth/reset-password', { token, newPassword: 'chosen by whoever holds the link' })
/** 用户自己在用户中心发起、还没确认的改邮箱 */
async function requestEmailChange(uid: number, email: string) {
  await core.users.changeEmail({ uid }, { email, password }, ROOT)
  const job = (await mails()).filter((mail) => mail.template === 'confirmEmailChange' && mail.to === email).at(-1)!
  return new URL(job.url!).searchParams.get('token')!
}
const launcherLogin = (email: string, value = password) =>
  core.yggdrasil.authenticate({
    username: email,
    password: value,
    rawPassword: value,
    clientToken: null,
    requestUser: false,
  })
const launcherValid = (accessToken: string) => core.yggdrasil.validate({ accessToken, clientToken: null })

interface MailPayload {
  template: string
  to: string
  uid: number
  url?: string
  changes?: ({ kind: string } & Record<string, unknown>)[]
}
const mails = async () =>
  (await db().selectFrom('jobs').select('payload').where('name', '=', MAIL_JOB).orderBy('id').execute()).map(
    (row) => JSON.parse(row.payload) as MailPayload,
  )
/** 后台修改账号的通知邮件（ADR-0036"通知邮件"） */
const notices = async () => (await mails()).filter((mail) => mail.template === 'adminAccountChanged')
const profileEvents = async () =>
  (await db().selectFrom('jobs').select('payload').where('name', '=', 'test:profile').orderBy('id').execute()).map(
    (row) => JSON.parse(row.payload) as { actor: Record<string, unknown>; data: { uid: number; fields: string[] } },
  )
async function audits(uid: number) {
  const rows = await db()
    .selectFrom('audit_logs')
    .select(['action', 'actor_type', 'actor_user_id', 'ip', 'details'])
    .where('subject_type', '=', 'user')
    .where('subject_id', '=', uid)
    .orderBy('id')
    .execute()
  return rows.map((row) => ({
    action: row.action,
    actor: row.actor_type === 'user' ? row.actor_user_id : row.actor_type,
    ip: row.ip,
    details: JSON.parse(row.details) as unknown,
  }))
}
/** 一个事务里写的几条审计，先后顺序不是契约 */
const unordered = <T>(rows: T[]) => rows.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
const bindings = (uid: number) =>
  db()
    .selectFrom('accounts')
    .select(['provider_id', 'account_id'])
    .where('user_id', '=', uid)
    .where('provider_id', 'like', 'plugin:%')
    .orderBy('id')
    .execute()
const passkeys = (uid: number) => countRows(db().selectFrom('passkeys').where('user_id', '=', uid))
const twoFactorRows = (uid: number) => countRows(db().selectFrom('two_factors').where('user_id', '=', uid))
async function twoFactorEnabled(uid: number) {
  const row = await db()
    .selectFrom('users')
    .select('two_factor_enabled')
    .where('id', '=', uid)
    .executeTakeFirstOrThrow()
  return readAuthBoolean(row.two_factor_enabled ?? false)
}
async function credentialHash(uid: number) {
  const row = await db()
    .selectFrom('accounts')
    .select('password')
    .where('user_id', '=', uid)
    .where('provider_id', '=', 'credential')
    .executeTakeFirst()
  return row?.password
}
async function version(uid: number) {
  return (await db().selectFrom('users').select('email_version').where('id', '=', uid).executeTakeFirstOrThrow())
    .email_version
}
const adminEventActor = () => ({ kind: 'user', uid: admin.uid, role: 'admin' })

const revokers: { name: string; run: (uid: number) => Promise<RevokedLogins>; after: string }[] = [
  { name: 'setUserPassword', run: (uid) => core.admin.setUserPassword(admin, uid, { password: fresh }), after: fresh },
  { name: 'deleteUserPasskeys', run: (uid) => core.admin.deleteUserPasskeys(admin, uid), after: password },
  {
    name: 'unlinkUserAccount',
    run: (uid) => core.admin.unlinkUserAccount(admin, uid, 'login', 'main'),
    after: password,
  },
  { name: 'revokeUserSessions', run: (uid) => core.admin.revokeUserSessions(admin, uid), after: password },
  {
    name: 'setPasswordAsSystem',
    run: (uid) => core.admin.setPasswordAsSystem(String(uid), { password: fresh }),
    after: fresh,
  },
]

test.each(revokers)(
  '作废在途的登录（$name）：旧会话、启动器令牌、两步验证的挑战、找回链接、还没确认的改邮箱链接都失效，别人的不受影响',
  async ({ run, after }) => {
    await configureMail()
    const target = await user('target')
    await passkey(target.uid)
    await bind(target.uid, 'login')
    const bystander = await user('bystander')
    // 启动器登录要在开启两步验证之前：之后就得在密码后面拼验证码
    const launcher = await launcherLogin(target.email)
    const otherLauncher = await launcherLogin(bystander.email)
    const emailLink = await requestEmailChange(target.uid, 'pending@example.test')
    const resetToken = await requestReset(target.email, target.uid)
    const otherReset = await requestReset(bystander.email, bystander.uid)
    const owner = await signIn(target.email)
    const secret = await enableTwoFactor(owner)
    const pending = await challenge(target.email)
    const other = await signIn(bystander.email)
    const otherSecret = await enableTwoFactor(other)
    const otherPending = await challenge(bystander.email)
    expect(await owner.session()).toMatchObject({ uid: target.uid })
    const sessions = await countRows(db().selectFrom('sessions').where('user_id', '=', target.uid))
    expect(sessions).toBeGreaterThan(0)

    for (const [uid, name] of [
      [target.uid, 'TargetPlayer'],
      [bystander.uid, 'OtherPlayer'],
    ] as const) {
      const pid = await insertReturningId(db(), 'players', {
        user_id: uid,
        name,
        name_key: name.toLowerCase(),
        uuid: String(uid).padStart(32, '0'),
        created_at: toIsoTimestamp(new Date()),
        updated_at: toIsoTimestamp(new Date()),
      })
      await seedOAuth(db(), uid, pid)
    }
    expect(await run(target.uid)).toMatchObject({ revokedSessions: sessions, revokedTokens: 1 })
    for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'device_code_selections'] as const) {
      expect(await countRows(db().selectFrom(table).where('user_id', '=', target.uid))).toBe(0)
      expect(await countRows(db().selectFrom(table).where('user_id', '=', bystander.uid))).toBeGreaterThan(0)
    }
    expect(await countRows(db().selectFrom('device_codes').where('user_id', '=', String(target.uid)))).toBe(0)
    expect(await countRows(db().selectFrom('device_codes').where('user_id', '=', String(bystander.uid)))).toBe(2)
    expect(await countRows(db().selectFrom('oauth_consents').where('user_id', '=', target.uid))).toBe(1)

    expect(await owner.session()).toBeNull()
    await expect(launcherValid(launcher.accessToken)).rejects.toMatchObject({ kind: 'ForbiddenOperationException' })
    expect(await countRows(db().selectFrom('yggdrasil_tokens').where('user_id', '=', target.uid))).toBe(0)
    const verified = await pending.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })
    expect(verified.status).toBe(401)
    expect(await verified.json()).toMatchObject({ code: 'INVALID_TWO_FACTOR_COOKIE' })
    expect(await pending.session()).toBeNull()
    const used = await reset(resetToken)
    expect(used.status).toBe(400)
    expect(await used.json()).toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(core.users.confirmEmailChange(emailLink)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
    expect((await core.users.profile(target.uid))?.email).toBe(target.email)

    expect(await other.session()).toMatchObject({ uid: bystander.uid })
    await expect(launcherValid(otherLauncher.accessToken)).resolves.toBeUndefined()
    expect(await resetTokens(bystander.uid)).toEqual([otherReset])
    // 挑战按值（uid）找，别人还没补完的第二步不受影响
    expect((await otherPending.request('/api/auth/two-factor/verify-totp', { code: totp(otherSecret) })).status).toBe(
      200,
    )
    expect(await otherPending.session()).toMatchObject({ uid: bystander.uid })

    // 之后照常能登录，两步验证还在；改了密码的只认新密码
    if (after !== password) expect((await attempt(target.email, password)).status).toBe(401)
    const next = await challenge(target.email, after)
    expect((await next.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })).status).toBe(200)
    expect(await next.session()).toMatchObject({ uid: target.uid })
  },
)

test('改密码：审计只记有没有新建密码行，不含密码；事件的 actor 是管理员；通知对方；不动通行密钥和绑定', async () => {
  await configureMail()
  const target = await user('target')
  await passkey(target.uid)
  await bind(target.uid, 'login')
  expect(await core.admin.setUserPassword(admin, target.uid, { password: fresh })).toEqual({
    revokedSessions: 0,
    revokedTokens: 0,
  })
  expect(await audits(target.uid)).toEqual([
    { action: 'user.setPassword', actor: admin.uid, ip: admin.ip, details: { nickname: 'target', created: false } },
  ])
  expect(await profileEvents()).toEqual([
    expect.objectContaining({ actor: adminEventActor(), data: { uid: target.uid, fields: ['password'] } }),
  ])
  expect(await notices()).toMatchObject([{ to: target.email, uid: target.uid, changes: [{ kind: 'password' }] }])
  const written = [
    ...(await db().selectFrom('audit_logs').select('details').execute()).map((row) => row.details),
    ...(await db().selectFrom('jobs').select('payload').execute()).map((row) => row.payload),
  ].join('\n')
  expect(written).not.toContain(fresh)
  expect(await passkeys(target.uid)).toBe(1)
  expect(await bindings(target.uid)).toHaveLength(1)
  expect((await attempt(target.email, fresh)).status).toBe(200)
})

test('没有密码的账号：插入密码那一行，审计记 created；没有配置邮件时不通知；之后网页和启动器都能用这个密码登录', async () => {
  const target = await user('target', { password: false })
  await bind(target.uid, 'login')
  expect(await core.admin.setUserPassword(admin, target.uid, { password: fresh })).toEqual({
    revokedSessions: 0,
    revokedTokens: 0,
  })
  expect(
    await db()
      .selectFrom('accounts')
      .select(['provider_id', 'account_id'])
      .where('user_id', '=', target.uid)
      .where('provider_id', '=', 'credential')
      .execute(),
  ).toEqual([{ provider_id: 'credential', account_id: String(target.uid) }])
  expect(await audits(target.uid)).toEqual([
    { action: 'user.setPassword', actor: admin.uid, ip: admin.ip, details: { nickname: 'target', created: true } },
  ])
  expect(await mails()).toEqual([])
  expect((await attempt(target.email, fresh)).status).toBe(200)
  await expect(launcherLogin(target.email, fresh)).resolves.toMatchObject({
    accessToken: expect.any(String) as unknown,
  })
})

/**
 * 后台的事务读到"没有密码行"之后，用户自己设置的密码才提交，后台的插入撞上唯一索引（ADR-0036"改密码和收回账号"）。
 * SQLite 只有一个连接，造不出真的交错：预先插好用户的那一行，在后台的第一次事务里把它藏起来（查询读不到、
 * UPDATE 不算数），效果和交错相同。执行插入的那一句解除，之后的重跑看到真实的数据
 */
function hideCredentialUntilInsert() {
  const hidden = new Set<QueryId>()
  const state = { armed: true, inserted: false }
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (state.armed) {
        const text = JSON.stringify(node, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value))
        if (text.includes('"accounts"') && text.includes('"credential"')) {
          if (node.kind === 'InsertQueryNode') {
            state.armed = false
            state.inserted = true
          } else if (node.kind === 'SelectQueryNode' || node.kind === 'UpdateQueryNode') hidden.add(queryId)
        }
      }
      return node
    },
    transformResult({ result, queryId }) {
      if (!hidden.delete(queryId)) return Promise.resolve(result)
      return Promise.resolve({
        ...result,
        rows: [],
        ...(result.numAffectedRows === undefined ? {} : { numAffectedRows: 0n }),
        ...(result.numChangedRows === undefined ? {} : { numChangedRows: 0n }),
      })
    },
  }
  return { plugin, state }
}

test('插入密码那一行时撞上用户刚设置的密码：整个用例重跑一次、走更新的路径，不出 500', async () => {
  const target = await user('target', { password: false })
  await credential(target.uid, await hashPassword('chosen by the user meanwhile'))
  const { plugin, state } = hideCredentialUntilInsert()
  const subject = createCore({ db: db().withPlugin(plugin), secretKey, production: false, textureStorage: storage })
  subject.events.subscribe('user.profileUpdated', 'test:profile', { run: () => Promise.resolve() })
  try {
    await expect(subject.admin.setUserPassword(admin, target.uid, { password: fresh })).resolves.toEqual({
      revokedSessions: 0,
      revokedTokens: 0,
    })
  } finally {
    await subject.shutdown()
  }
  // 第一次确实走到了插入：重跑是唯一冲突引起的。实现改了读密码行的方式时，要相应调整上面的插件
  expect(state.inserted).toBe(true)
  expect(
    await countRows(
      db().selectFrom('accounts').where('user_id', '=', target.uid).where('provider_id', '=', 'credential'),
    ),
  ).toBe(1)
  expect((await attempt(target.email, fresh)).status).toBe(200)
  expect((await attempt(target.email, 'chosen by the user meanwhile')).status).toBe(401)
  expect(await audits(target.uid)).toEqual([
    { action: 'user.setPassword', actor: admin.uid, ip: admin.ip, details: { nickname: 'target', created: false } },
  ])
  expect((await profileEvents()).map((event) => event.data)).toEqual([{ uid: target.uid, fields: ['password'] }])
})

test('密码长度按 password.length 在 8 到 128 之间；新邮箱照注册的规则校验；不合法时什么也不改', async () => {
  const target = await user('target')
  const before = await credentialHash(target.uid)
  await expect(core.admin.setUserPassword(admin, target.uid, { password: 'a'.repeat(7) })).rejects.toMatchObject({
    code: 'password_too_short',
    params: { min: 8 },
  })
  await expect(core.admin.setUserPassword(admin, target.uid, { password: 'a'.repeat(129) })).rejects.toMatchObject({
    code: 'password_too_long',
    params: { max: 128 },
  })
  await expect(
    core.admin.setUserPassword(admin, target.uid, { password: fresh, newEmail: 'invalid' }),
  ).rejects.toMatchObject({ code: 'email_invalid' })
  expect(await credentialHash(target.uid)).toBe(before)
  expect(await audits(target.uid)).toEqual([])
  // 四个 emoji 是 8 个 UTF-16 码元：和 Better Auth 注册、改密码时的算法相同
  await core.admin.setUserPassword(admin, target.uid, { password: '😀'.repeat(4) })
  await core.admin.setUserPassword(admin, target.uid, { password: 'a'.repeat(128) })
  expect((await attempt(target.email, 'a'.repeat(128))).status).toBe(200)
})

test('收回账号：一个事务里设密码、删掉全部通行密钥、解绑全部第三方账号（包括插件停用了的）、邮箱立即换成新地址并算已验证', async () => {
  await configureMail()
  const target = await user('target')
  await db().updateTable('users').set({ email_verified: false }).where('id', '=', target.uid).execute()
  await passkey(target.uid)
  await passkey(target.uid)
  await bind(target.uid, 'login')
  await bind(target.uid, 'other')
  await core.plugins.admin.disable(root, 'other')
  const owner = await signIn(target.email)
  const before = await version(target.uid)

  expect(
    await core.admin.setUserPassword(admin, target.uid, {
      password: fresh,
      removeOtherMethods: true,
      newEmail: 'recovered@example.test',
    }),
  ).toEqual({ revokedSessions: 1, revokedTokens: 0 })

  expect(await owner.session()).toBeNull()
  expect(await passkeys(target.uid)).toBe(0)
  expect(await bindings(target.uid)).toEqual([])
  expect(await core.users.profile(target.uid)).toMatchObject({ email: 'recovered@example.test', emailVerified: true })
  expect(await version(target.uid)).toBeGreaterThan(before)
  const nickname = 'target'
  expect(unordered(await audits(target.uid))).toEqual(
    unordered(
      [
        { action: 'user.deletePasskeys', details: { nickname, count: 2 } },
        { action: 'user.unlinkAccount', details: { nickname, plugin: 'login', provider: 'main' } },
        { action: 'user.unlinkAccount', details: { nickname, plugin: 'other', provider: 'main' } },
        {
          action: 'user.setEmail',
          details: { nickname, from: target.email, to: 'recovered@example.test', pending: false, verified: true },
        },
        { action: 'user.setPassword', details: { nickname, created: false } },
      ].map((row) => ({ ...row, actor: admin.uid, ip: admin.ip })),
    ),
  )
  expect(unordered((await profileEvents()).map((event) => ({ actor: event.actor, data: event.data })))).toEqual(
    unordered([
      { actor: adminEventActor(), data: { uid: target.uid, fields: ['email'] } },
      { actor: adminEventActor(), data: { uid: target.uid, fields: ['password'] } },
    ]),
  )
  // 一封通知，列出这次改的全部项目，发给旧地址；新地址不发确认链接
  const sent = await notices()
  expect(sent).toMatchObject([{ to: target.email, uid: target.uid }])
  const changes = sent[0]!.changes!
  expect(changes).toHaveLength(5)
  expect(changes).toEqual(
    expect.arrayContaining([
      { kind: 'password' },
      { kind: 'passkeys', count: 2 },
      { kind: 'binding', provider: expect.any(String) as unknown },
      { kind: 'email', pending: false },
    ]) as unknown,
  )
  expect(changes.filter((change) => change.kind === 'binding')).toHaveLength(2)
  expect((await mails()).filter((mail) => mail.template === 'confirmEmailChange')).toEqual([])
  // 旧地址、旧密码都登录不了
  expect((await attempt(target.email, fresh)).status).toBe(401)
  expect((await attempt('recovered@example.test', password)).status).toBe(401)
  expect((await attempt('recovered@example.test', fresh)).status).toBe(200)
})

test('收回账号对被封禁的对象也能做，身份不变', async () => {
  const target = await user('target', { role: 'banned' })
  await passkey(target.uid)
  await bind(target.uid, 'login')
  expect(
    await core.admin.setUserPassword(admin, target.uid, {
      password: fresh,
      removeOtherMethods: true,
      newEmail: 'recovered@example.test',
    }),
  ).toEqual({ revokedSessions: 0, revokedTokens: 0 })
  expect(await core.users.profile(target.uid)).toMatchObject({
    email: 'recovered@example.test',
    emailVerified: true,
    role: 'banned',
  })
  expect(await passkeys(target.uid)).toBe(0)
  expect(await bindings(target.uid)).toEqual([])
})

test.each(['email_taken', 'email_unchanged', 'enqueue_failed'] as const)(
  '收回账号的任何一步失败都整体回滚（%s）',
  async (failure) => {
    await configureMail()
    const target = await user('target')
    await user('taken')
    await passkey(target.uid)
    await bind(target.uid, 'login')
    await bind(target.uid, 'other')
    const owner = await signIn(target.email)
    const launcher = await launcherLogin(target.email)
    const snapshot = async () => ({
      user: await db().selectFrom('users').selectAll().where('id', '=', target.uid).executeTakeFirstOrThrow(),
      accounts: await db().selectFrom('accounts').selectAll().where('user_id', '=', target.uid).orderBy('id').execute(),
      passkeys: await passkeys(target.uid),
      sessions: await countRows(db().selectFrom('sessions').where('user_id', '=', target.uid)),
      tokens: await countRows(db().selectFrom('yggdrasil_tokens').where('user_id', '=', target.uid)),
    })
    const before = await snapshot()
    const newEmail =
      failure === 'email_taken'
        ? 'taken@example.test'
        : failure === 'email_unchanged'
          ? target.email
          : 'recovered@example.test'
    const call = () =>
      core.admin.setUserPassword(admin, target.uid, { password: fresh, removeOtherMethods: true, newEmail })
    if (failure === 'enqueue_failed') {
      const enqueue = core.jobs.enqueue.bind(core.jobs)
      const spy = vi.spyOn(core.jobs, 'enqueue').mockImplementation((tx, name, payload, options) => {
        if (name === MAIL_JOB) throw new Error('enqueue_failed')
        return enqueue(tx, name, payload, options)
      })
      try {
        await expect(call()).rejects.toThrow('enqueue_failed')
      } finally {
        spy.mockRestore()
      }
    } else await expect(call()).rejects.toMatchObject({ code: failure })
    expect(await snapshot()).toEqual(before)
    expect(await owner.session()).toMatchObject({ uid: target.uid })
    await expect(launcherValid(launcher.accessToken)).resolves.toBeUndefined()
    expect(await audits(target.uid)).toEqual([])
    expect(await profileEvents()).toEqual([])
    expect(await notices()).toEqual([])
  },
)

test.each(['setUserPassword', 'unlinkUserAccount'] as const)(
  '第三方绑定的回调正在换令牌时后台 %s，最终没有新的绑定',
  async (operation) => {
    const target = await user('target')
    await bind(target.uid, 'other')
    const owner = await signIn(target.email)
    const { sessionId } = (await owner.session())!
    const { state } = await core.externalLogin.start({
      pluginId: 'login',
      providerId: 'main',
      intent: 'link',
      uid: target.uid,
      sessionId,
      next: '/user/security',
      siteUrl,
    })
    const gate = Promise.withResolvers<typeof identity>()
    exchange.mockImplementationOnce(() => gate.promise)
    const outcome = core.externalLogin
      .callback({
        pluginId: 'login',
        providerId: 'main',
        query: { state },
        cookieState: state,
        sessionUid: target.uid,
        sessionId,
        siteUrl,
      })
      .then(
        () => 'linked',
        (error: unknown) => error,
      )
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce())
    // 后台的事务删完会话、停在提交之前，这时换令牌回来：写绑定的事务排在用户行锁上，锁内才看得到会话没了
    const pause = pauseNextCommit(db())
    try {
      const revoking =
        operation === 'setUserPassword'
          ? core.admin.setUserPassword(admin, target.uid, { password: fresh, removeOtherMethods: true })
          : core.admin.unlinkUserAccount(admin, target.uid, 'other', 'main')
      await Promise.race([pause.entered, revoking])
      gate.resolve({ ...identity })
      await pause.contended
      // 给写绑定的事务一点时间走到用户行锁上
      await new Promise((resolve) => setTimeout(resolve, 100))
      pause.resume()
      await revoking
    } finally {
      pause.restore()
    }
    expect(await outcome).toMatchObject({ code: 'external_login_expired' })
    expect(await bindings(target.uid)).toEqual([])
  },
)

/** 停在 core.settings.read 读到 key 的那一刻做 run，只停一次 */
function pauseAtSetting(key: CoreSettingKey, run: () => Promise<unknown>) {
  const read = core.settings.read.bind(core.settings)
  const spy = vi.spyOn(core.settings, 'read').mockImplementation(async (keys) => {
    if (keys.includes(key)) {
      spy.mockRestore()
      await run()
    }
    return read(keys)
  })
  return spy
}

test.each([false, true])(
  'Better Auth 改密码核对了旧密码、还没写入时后台收回了账号：改密码被拒绝、整体回滚，管理员设的密码有效（revokeOtherSessions: %s）',
  async (revokeOtherSessions) => {
    const target = await user('target')
    const attacker = await signIn(target.email)
    // 旧格式的哈希核对时要读全站盐，停在这里收回账号：Better Auth 已经过了会话检查，正在核对旧密码
    await db()
      .updateTable('accounts')
      .set({ password: `$bs$sha256$${createHash('sha256').update(password).digest('hex')}` })
      .where('user_id', '=', target.uid)
      .where('provider_id', '=', 'credential')
      .execute()
    const spy = pauseAtSetting('auth.legacyPasswordSalt', () =>
      core.admin.setUserPassword(admin, target.uid, { password: fresh, removeOtherMethods: true }),
    )
    try {
      const response = await attacker.request('/api/auth/change-password', {
        currentPassword: password,
        newPassword: 'chosen by the attacker',
        revokeOtherSessions,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_PASSWORD' })
    } finally {
      spy.mockRestore()
    }
    expect(await attacker.session()).toBeNull()
    expect(await countRows(db().selectFrom('sessions').where('user_id', '=', target.uid))).toBe(0)
    expect((await attempt(target.email, 'chosen by the attacker')).status).toBe(401)
    expect((await attempt(target.email, fresh)).status).toBe(200)
  },
)

test.each([false, true])(
  '没有并发时 Better Auth 改密码照常成功，新密码有效（revokeOtherSessions: %s）',
  async (revokeOtherSessions) => {
    const target = await user('target')
    const owner = await signIn(target.email)
    const other = await signIn(target.email)
    const response = await owner.request('/api/auth/change-password', {
      currentPassword: password,
      newPassword: 'changed by the owner',
      revokeOtherSessions,
    })
    expect(response.status).toBe(200)
    expect(await owner.session()).toMatchObject({ uid: target.uid })
    if (revokeOtherSessions) expect(await other.session()).toBeNull()
    else expect(await other.session()).toMatchObject({ uid: target.uid })
    expect((await attempt(target.email, password)).status).toBe(401)
    expect((await attempt(target.email, 'changed by the owner')).status).toBe(200)
  },
)

test.each([
  ['changeEmail', 'site.url'],
  ['deleteAccount', 'score.refundOnDelete'],
] as const)(
  '用户侧 %s 核对了旧密码、还没锁住用户时后台收回了账号：按密码不对拒绝，什么也不改',
  async (operation, gate) => {
    await configureMail()
    const target = await user('target')
    // 核对密码之后才读这个设置，停在这里收回账号
    const spy = pauseAtSetting(gate, () =>
      core.admin.setUserPassword(admin, target.uid, {
        password: fresh,
        removeOtherMethods: true,
        newEmail: 'recovered@example.test',
      }),
    )
    try {
      const call =
        operation === 'changeEmail'
          ? core.users.changeEmail({ uid: target.uid }, { email: 'attacker@example.test', password }, ROOT)
          : core.users.deleteAccount({ uid: target.uid }, { password })
      await expect(call).rejects.toMatchObject({ code: 'password_incorrect' })
    } finally {
      spy.mockRestore()
    }
    expect(
      await db().selectFrom('users').select(['email', 'role']).where('id', '=', target.uid).executeTakeFirst(),
    ).toEqual({ email: 'recovered@example.test', role: 'user' })
    expect((await mails()).filter((mail) => mail.template === 'confirmEmailChange')).toEqual([])
    expect((await attempt('recovered@example.test', fresh)).status).toBe(200)
  },
)

test('关两步验证：删掉密钥、挑战和信任设备的记录；不退出登录；之后能重新开启，信任过的设备要重新过第二步', async () => {
  await configureMail()
  const target = await user('target')
  const owner = await signIn(target.email)
  const secret = await enableTwoFactor(owner)
  const trusted = await challenge(target.email)
  const trust = await trusted.request('/api/auth/two-factor/verify-totp', { code: totp(secret), trustDevice: true })
  expect(trust.status).toBe(200)
  // 前提：信任过的设备登录不用过第二步
  const device = carryTrust(trusted)
  expect((await device.request('/api/auth/sign-in/email', { email: target.email, password })).status).toBe(200)
  expect(await device.session()).toMatchObject({ uid: target.uid })
  const pending = await challenge(target.email)
  const challenges = (
    await db()
      .selectFrom('verifications')
      .select('identifier')
      .where('identifier', 'like', '2fa-%')
      .where('identifier', 'not like', '2fa-attempts-%')
      .where('value', '=', String(target.uid))
      .execute()
  ).map((row) => row.identifier)
  expect(challenges).toHaveLength(1)
  const challengeRows = [...challenges, ...challenges.map((identifier) => `2fa-attempts-${identifier}`)]
  expect(await countRows(db().selectFrom('verifications').where('identifier', 'in', challengeRows))).toBe(2)
  // 别人的信任设备和还没补完的第二步
  const bystander = await user('bystander')
  const otherSecret = await enableTwoFactor(await signIn(bystander.email))
  const otherTrusted = await challenge(bystander.email)
  expect(
    (await otherTrusted.request('/api/auth/two-factor/verify-totp', { code: totp(otherSecret), trustDevice: true }))
      .status,
  ).toBe(200)
  const otherPending = await challenge(bystander.email)

  expect(await core.admin.disableUserTwoFactor(admin, target.uid)).toMatchObject({ uid: target.uid })

  // 挑战和信任设备都按值（uid）找，别人的不受影响
  const otherDevice = carryTrust(otherTrusted)
  expect(
    await (await otherDevice.request('/api/auth/sign-in/email', { email: bystander.email, password })).json(),
  ).not.toHaveProperty('twoFactorRedirect')
  expect(await otherDevice.session()).toMatchObject({ uid: bystander.uid })
  expect((await otherPending.request('/api/auth/two-factor/verify-totp', { code: totp(otherSecret) })).status).toBe(200)

  expect(await twoFactorRows(target.uid)).toBe(0)
  expect(await twoFactorEnabled(target.uid)).toBe(false)
  expect(await countRows(db().selectFrom('verifications').where('identifier', 'in', challengeRows))).toBe(0)
  expect(
    await countRows(
      db()
        .selectFrom('verifications')
        .where('identifier', 'like', 'trust-device-%')
        .where('value', '=', String(target.uid)),
    ),
  ).toBe(0)
  // 不退出登录：已有的会话本来就过了第二步
  expect(await owner.session()).toMatchObject({ uid: target.uid })
  expect(await device.session()).toMatchObject({ uid: target.uid })
  const verified = await pending.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })
  expect(verified.status).toBe(401)
  expect(await pending.session()).toBeNull()
  expect(await (await attempt(target.email, password)).json()).not.toHaveProperty('twoFactorRedirect')
  expect(await audits(target.uid)).toEqual([
    { action: 'user.disableTwoFactor', actor: admin.uid, ip: admin.ip, details: { nickname: 'target' } },
  ])
  expect(await notices()).toMatchObject([{ to: target.email, uid: target.uid, changes: [{ kind: 'twoFactor' }] }])
  expect(await profileEvents()).toEqual([])

  // 只改开关、不删密钥行的话，这里会被 Better Auth 以"已经开启"拒绝
  const next = await enableTwoFactor(owner)
  const later = carryTrust(device)
  const signed = await later.request('/api/auth/sign-in/email', { email: target.email, password })
  expect(await signed.json()).toMatchObject({ twoFactorRedirect: true })
  expect(await later.session()).toBeNull()
  expect((await later.request('/api/auth/two-factor/verify-totp', { code: totp(next) })).status).toBe(200)
  expect(await later.session()).toMatchObject({ uid: target.uid })
})

test('关两步验证清掉网页和启动器共用的失败锁定：之后启动器只用密码就能登录', async () => {
  const target = await user('target')
  const secret = await enableTwoFactor(await signIn(target.email))
  await db()
    .updateTable('two_factors')
    .set({
      failed_verification_count: 10,
      locked_until: writeAuthDate(db(), toIsoTimestamp(new Date(Date.now() + 900_000))),
    })
    .where('user_id', '=', target.uid)
    .execute()
  await expect(launcherLogin(target.email, password + totp(secret))).rejects.toMatchObject({
    kind: 'ForbiddenOperationException',
  })
  await core.admin.disableUserTwoFactor(admin, target.uid)
  await expect(launcherLogin(target.email)).resolves.toMatchObject({ accessToken: expect.any(String) as unknown })
})

test('两步验证已经关着、也没有密钥行时不写审计、不通知，但照样删掉信任设备的记录；开启到一半（有密钥行、开关还关着）时照样清掉', async () => {
  await configureMail()
  const target = await user('target')
  const owner = await signIn(target.email)
  const secret = await enableTwoFactor(owner)
  const trusted = await challenge(target.email)
  expect(
    (await trusted.request('/api/auth/two-factor/verify-totp', { code: totp(secret), trustDevice: true })).status,
  ).toBe(200)
  // 用户在另一台设备上自己关掉：Better Auth 只删那台设备的信任记录，丢了的这台设备的还在
  expect((await owner.request('/api/auth/two-factor/disable', { password })).status).toBe(200)
  const trustRecords = () =>
    countRows(
      db()
        .selectFrom('verifications')
        .where('identifier', 'like', 'trust-device-%')
        .where('value', '=', String(target.uid)),
    )
  expect(await trustRecords()).toBe(1)
  expect(await core.admin.disableUserTwoFactor(admin, target.uid)).toMatchObject({ uid: target.uid })
  expect(await trustRecords()).toBe(0)
  expect(await audits(target.uid)).toEqual([])
  expect(await notices()).toEqual([])
  // 重新开启之后，丢了的设备要重新过第二步
  await enableTwoFactor(owner)
  const device = carryTrust(trusted)
  const signed = await device.request('/api/auth/sign-in/email', { email: target.email, password })
  expect(await signed.json()).toMatchObject({ twoFactorRedirect: true })
  expect(await device.session()).toBeNull()

  const half = await user('half')
  const halfOwner = await signIn(half.email)
  expect((await halfOwner.request('/api/auth/two-factor/enable', { password })).status).toBe(200)
  expect(await twoFactorRows(half.uid)).toBe(1)
  expect(await twoFactorEnabled(half.uid)).toBe(false)
  await core.admin.disableUserTwoFactor(admin, half.uid)
  expect(await twoFactorRows(half.uid)).toBe(0)
  expect((await audits(half.uid)).map((row) => row.action)).toEqual(['user.disableTwoFactor'])
  expect(await notices()).toMatchObject([{ to: half.email, changes: [{ kind: 'twoFactor' }] }])
})

test('删通行密钥：全部删掉并作废在途的登录，审计记数量，通知对方；已经一把也没有时照样作废，不通知', async () => {
  await configureMail()
  const target = await user('target')
  await passkey(target.uid)
  await passkey(target.uid)
  const owner = await signIn(target.email)
  await launcherLogin(target.email)
  expect(await core.admin.deleteUserPasskeys(admin, target.uid)).toEqual({
    deleted: 2,
    revokedSessions: 1,
    revokedTokens: 1,
  })
  expect(await passkeys(target.uid)).toBe(0)
  expect(await owner.session()).toBeNull()
  expect(await audits(target.uid)).toEqual([
    { action: 'user.deletePasskeys', actor: admin.uid, ip: admin.ip, details: { nickname: 'target', count: 2 } },
  ])
  expect(await notices()).toMatchObject([
    { to: target.email, uid: target.uid, changes: [{ kind: 'passkeys', count: 2 }] },
  ])
  expect(await profileEvents()).toEqual([])

  // 管理员打开对话框之后通行密钥被删光了：拿着它登进来的会话还在，照样作废
  const again = await signIn(target.email)
  const before = await version(target.uid)
  expect(await core.admin.deleteUserPasskeys(admin, target.uid)).toEqual({
    deleted: 0,
    revokedSessions: 1,
    revokedTokens: 0,
  })
  expect(await again.session()).toBeNull()
  expect(await version(target.uid)).toBe(before + 1)
  expect((await audits(target.uid)).at(-1)).toEqual({
    action: 'user.deletePasskeys',
    actor: admin.uid,
    ip: admin.ip,
    details: { nickname: 'target', count: 0 },
  })
  expect(await notices()).toHaveLength(1)
})

test('删通行密钥会删掉最后一种能用的登录方式时 409：空密码、插件停用了的绑定不算；绑着能用的第三方、或者设了密码之后可以', async () => {
  const target = await user('target', { password: false })
  await passkey(target.uid)
  const refused = async (uid: number) => {
    await expect(core.admin.deleteUserPasskeys(admin, uid)).rejects.toMatchObject({ code: 'last_login_method' })
    expect(await passkeys(uid)).toBe(1)
  }
  await refused(target.uid)
  await credential(target.uid, null)
  await refused(target.uid)
  await bind(target.uid, 'other')
  await core.plugins.admin.disable(root, 'other')
  await refused(target.uid)
  expect(await audits(target.uid)).toEqual([])
  await core.plugins.admin.enable(root, 'other')
  expect(await core.admin.deleteUserPasskeys(admin, target.uid)).toMatchObject({ deleted: 1 })

  const second = await user('second', { password: false })
  await passkey(second.uid)
  await refused(second.uid)
  await core.admin.setUserPassword(admin, second.uid, { password: fresh })
  expect(await core.admin.deleteUserPasskeys(admin, second.uid)).toMatchObject({ deleted: 1 })
})

test('解绑：删掉这条绑定并作废在途的登录，审计记插件和 Provider，通知对方；没有这条绑定时 external_account_not_found', async () => {
  await configureMail()
  const target = await user('target')
  const bystander = await user('bystander')
  await bind(target.uid, 'login')
  await bind(target.uid, 'other')
  await bind(bystander.uid, 'login')
  const owner = await signIn(target.email)
  expect(await core.admin.unlinkUserAccount(admin, target.uid, 'login', 'main')).toEqual({
    revokedSessions: 1,
    revokedTokens: 0,
  })
  expect((await bindings(target.uid)).map((row) => row.provider_id)).toEqual(['plugin:other:main'])
  expect(await bindings(bystander.uid)).toHaveLength(1)
  expect(await owner.session()).toBeNull()
  expect(await audits(target.uid)).toEqual([
    {
      action: 'user.unlinkAccount',
      actor: admin.uid,
      ip: admin.ip,
      details: { nickname: 'target', plugin: 'login', provider: 'main' },
    },
  ])
  expect(await notices()).toMatchObject([
    { to: target.email, uid: target.uid, changes: [{ kind: 'binding', provider: expect.any(String) as unknown }] },
  ])
  expect(await profileEvents()).toEqual([])
  for (const [pluginId, providerId] of [
    ['login', 'main'],
    ['other', 'missing'],
    ['missing', 'main'],
  ] as const)
    await expect(core.admin.unlinkUserAccount(admin, target.uid, pluginId, providerId)).rejects.toMatchObject({
      code: 'external_account_not_found',
    })
  expect(await audits(target.uid)).toHaveLength(1)
  expect(await bindings(bystander.uid)).toHaveLength(1)
})

test('解绑会解掉最后一种能用的登录方式时 409，另有能用的绑定、通行密钥或密码时可以；插件停用了的绑定总能解', async () => {
  // 另一条能用的绑定算一种登录方式
  const pair = await user('pair', { password: false })
  await bind(pair.uid, 'login')
  await bind(pair.uid, 'other')
  await core.admin.unlinkUserAccount(admin, pair.uid, 'login', 'main')
  expect((await bindings(pair.uid)).map((row) => row.provider_id)).toEqual(['plugin:other:main'])

  await core.plugins.admin.disable(root, 'other')
  // 只剩一条插件停用了的绑定：它本来就不能用来登录，解不解都不改变账号能不能登录
  const stranded = await user('stranded', { password: false })
  await bind(stranded.uid, 'other')
  await core.admin.unlinkUserAccount(admin, stranded.uid, 'other', 'main')
  expect(await bindings(stranded.uid)).toEqual([])

  // 插件停用了的绑定不算另一种登录方式
  const target = await user('target', { password: false })
  await bind(target.uid, 'login')
  await bind(target.uid, 'other')
  await expect(core.admin.unlinkUserAccount(admin, target.uid, 'login', 'main')).rejects.toMatchObject({
    code: 'last_login_method',
  })
  expect(await bindings(target.uid)).toHaveLength(2)
  expect(await audits(target.uid)).toEqual([])
  await core.admin.unlinkUserAccount(admin, target.uid, 'other', 'main')
  await passkey(target.uid)
  await core.admin.unlinkUserAccount(admin, target.uid, 'login', 'main')
  expect(await bindings(target.uid)).toEqual([])

  const linked = await user('linked', { password: false })
  await bind(linked.uid, 'login')
  await expect(core.admin.unlinkUserAccount(admin, linked.uid, 'login', 'main')).rejects.toMatchObject({
    code: 'last_login_method',
  })
  await core.admin.setUserPassword(admin, linked.uid, { password: fresh })
  await core.admin.unlinkUserAccount(admin, linked.uid, 'login', 'main')
  expect(await bindings(linked.uid)).toEqual([])
})

test('退出全部登录：审计记删掉的会话数和令牌数；密码、通行密钥、绑定和两步验证都不动；不通知、不发事件', async () => {
  await configureMail()
  const target = await user('target')
  await passkey(target.uid)
  await bind(target.uid, 'login')
  await launcherLogin(target.email)
  await launcherLogin(target.email)
  await signIn(target.email)
  await enableTwoFactor(await signIn(target.email))
  const sessions = await countRows(db().selectFrom('sessions').where('user_id', '=', target.uid))
  expect(sessions).toBeGreaterThanOrEqual(2)
  const before = await credentialHash(target.uid)

  expect(await core.admin.revokeUserSessions(admin, target.uid)).toEqual({
    revokedSessions: sessions,
    revokedTokens: 2,
  })
  expect(await audits(target.uid)).toEqual([
    {
      action: 'user.revokeSessions',
      actor: admin.uid,
      ip: admin.ip,
      details: { nickname: 'target', sessions, tokens: 2 },
    },
  ])
  expect(await credentialHash(target.uid)).toBe(before)
  expect(await passkeys(target.uid)).toBe(1)
  expect(await bindings(target.uid)).toHaveLength(1)
  expect(await twoFactorEnabled(target.uid)).toBe(true)
  expect(await twoFactorRows(target.uid)).toBe(1)
  expect(await notices()).toEqual([])
  expect(await profileEvents()).toEqual([])
  expect(await core.admin.revokeUserSessions(admin, target.uid)).toEqual({ revokedSessions: 0, revokedTokens: 0 })
})

test('setPasswordAsSystem 按 uid 找到邮箱已被换掉的超级管理员，一个事务里收回账号；actor 是 system，审计的 ip 为空', async () => {
  await configureMail()
  const boss = await user('boss', { role: 'superadmin' })
  await passkey(boss.uid)
  await bind(boss.uid, 'login')
  // 知道密码的人先用用户侧的改邮箱把邮箱换成了自己的
  await db().updateTable('users').set({ email: 'intruder@example.test' }).where('id', '=', boss.uid).execute()
  const intruder = await signIn('intruder@example.test')
  // 后台动不了超级管理员，所以要有命令行
  await expect(core.admin.setUserPassword(admin, boss.uid, { password: fresh })).rejects.toMatchObject({
    code: 'user_not_manageable',
  })

  expect(
    await core.admin.setPasswordAsSystem(String(boss.uid), {
      password: fresh,
      removeOtherMethods: true,
      newEmail: 'boss@example.test',
    }),
  ).toEqual({ uid: boss.uid, nickname: 'boss', revokedSessions: 1, revokedTokens: 0 })

  expect(await intruder.session()).toBeNull()
  expect(await passkeys(boss.uid)).toBe(0)
  expect(await bindings(boss.uid)).toEqual([])
  expect(await core.users.profile(boss.uid)).toMatchObject({
    email: 'boss@example.test',
    emailVerified: true,
    role: 'superadmin',
  })
  const logs = await audits(boss.uid)
  expect(logs.map((row) => row.action).sort()).toEqual([
    'user.deletePasskeys',
    'user.setEmail',
    'user.setPassword',
    'user.unlinkAccount',
  ])
  expect(logs.every((row) => row.actor === 'system' && row.ip === null)).toBe(true)
  expect(logs.find((row) => row.action === 'user.setEmail')?.details).toEqual({
    nickname: 'boss',
    from: 'intruder@example.test',
    to: 'boss@example.test',
    pending: false,
    verified: true,
  })
  const events = await profileEvents()
  expect(events.map((event) => event.actor)).toEqual([{ kind: 'system' }, { kind: 'system' }])
  expect(events.map((event) => event.data.fields.join()).sort()).toEqual(['email', 'password'])
  // 改了邮箱时通知发给旧地址
  expect(await notices()).toMatchObject([{ to: 'intruder@example.test', uid: boss.uid }])
  expect((await attempt('boss@example.test', fresh)).status).toBe(200)

  expect(await core.admin.setPasswordAsSystem('boss@example.test', { password: password })).toMatchObject({
    uid: boss.uid,
    nickname: 'boss',
  })
  expect((await attempt('boss@example.test', password)).status).toBe(200)
  for (const target of ['2147483647', '2147483648', '0', 'nobody@example.test'])
    await expect(core.admin.setPasswordAsSystem(target, { password: fresh })).rejects.toMatchObject({
      code: 'user_not_found',
    })
})

test('disableTwoFactorAsSystem 按邮箱或 uid 关掉超级管理员的两步验证；actor 是 system，审计的 ip 为空', async () => {
  const boss = await user('boss', { role: 'superadmin' })
  const owner = await signIn(boss.email)
  await enableTwoFactor(owner)
  await expect(core.admin.disableUserTwoFactor(admin, boss.uid)).rejects.toMatchObject({
    code: 'user_not_manageable',
  })
  expect(await core.admin.disableTwoFactorAsSystem(boss.email)).toMatchObject({ uid: boss.uid, role: 'superadmin' })
  expect(await twoFactorEnabled(boss.uid)).toBe(false)
  expect(await twoFactorRows(boss.uid)).toBe(0)
  expect(await owner.session()).toMatchObject({ uid: boss.uid })
  await enableTwoFactor(owner)
  await core.admin.disableTwoFactorAsSystem(String(boss.uid))
  expect(await twoFactorRows(boss.uid)).toBe(0)
  const entry = { action: 'user.disableTwoFactor', actor: 'system', ip: null, details: { nickname: 'boss' } }
  expect(await audits(boss.uid)).toEqual([entry, entry])
  await expect(core.admin.disableTwoFactorAsSystem('nobody@example.test')).rejects.toMatchObject({
    code: 'user_not_found',
  })
})
