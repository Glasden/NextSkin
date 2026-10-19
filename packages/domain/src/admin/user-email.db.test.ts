import { markSiteInitialized } from '../setup/initialized.test-helper.ts'
import {
  coreMigrations,
  countRows,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  upsert,
  writeAuthDate,
  type CoreDatabase,
  type UserRole,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { hashPassword } from 'better-auth/crypto'
import type { KyselyPlugin, QueryId } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { Browser, ROOT } from '../auth/security.test-helper.ts'
import { createCore, encodeSettingValue, type Core, type CoreSettingKey, type CoreSettingValue } from '../index.ts'
import { MAIL_JOB } from '../mail/service.ts'
import { createEmailChangeTokens } from '../users/email-change-token.ts'

// 后台改邮箱（ADR-0036"改邮箱"）：配置了邮件时先发确认链接，没有配置时立即生效。
// 找回密码和登录走真实的 Better Auth 流程

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const password = 'correct horse battery staple'
const storage = {
  list: () => Promise.resolve([]),
  listTemp: () => Promise.resolve([]),
  lateDeleteWindowMs: 0,
  write: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  deleteTemp: () => Promise.resolve(),
  read: () => Promise.resolve(null),
}
let database: TestDatabase<CoreDatabase>
let core: Core
let hash: string
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
  await db().deleteFrom('users').execute()
  await db().deleteFrom('jobs').execute()
  await db().deleteFrom('settings').execute()
  await db().deleteFrom('verifications').execute()
  await db().deleteFrom('audit_logs').execute()
  core = createCore({
    db: db(),
    secretKey,
    production: false,
    textureStorage: storage,
    mailTransport: { send: () => Promise.resolve({ messageId: null }) },
  })
  admin = { uid: (await user('admin', 'admin')).uid, ip: '192.0.2.1' }
  core.events.subscribe('user.profileUpdated', 'test:profile', { run: () => Promise.resolve() })
})

async function user(name: string, role: UserRole = 'user') {
  const email = `${name}@example.test`
  const now = writeAuthDate(db(), toIsoTimestamp(new Date()))
  const uid = await insertReturningId(db(), 'users', {
    nickname: name,
    email,
    role,
    email_verified: true,
    locale: 'en',
    created_at: now,
    updated_at: now,
  })
  await db()
    .insertInto('accounts')
    .values({
      user_id: uid,
      provider_id: 'credential',
      account_id: String(uid),
      password: hash,
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
  return { uid, email }
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
async function configureMail(siteUrl: string | null = ROOT) {
  if (siteUrl !== null) await setting('site.url', siteUrl)
  await setting('mail.transport', 'smtp')
  await setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
}

const change = (uid: number, email: string, verified?: boolean, requestRoot = ROOT) =>
  core.admin.changeUserEmail(admin, uid, verified === undefined ? { email } : { email, verified }, requestRoot)
const attempt = (email: string, value = password) =>
  new Browser(core).request('/api/auth/sign-in/email', { email, password: value })
async function signIn(email: string) {
  const browser = new Browser(core)
  expect((await browser.request('/api/auth/sign-in/email', { email, password })).status).toBe(200)
  return browser
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
/** 经 Better Auth 申请找回密码，确认信发到了这个地址，返回这次签发的令牌 */
async function requestReset(email: string, uid: number) {
  const before = new Set(await resetTokens(uid))
  const response = await new Browser(core).request('/api/auth/request-password-reset', {
    email,
    redirectTo: `${ROOT}/reset-password`,
  })
  expect(response.status).toBe(200)
  expect((await mails()).at(-1)).toMatchObject({ template: 'resetPassword', to: email, uid })
  const token = (await resetTokens(uid)).find((value) => !before.has(value))
  expect(token).toBeDefined()
  return token!
}
/** 站点之前配置过邮件时发出、还没用的找回链接：直接写成 Better Auth 的格式（标识按明文存储） */
async function storedResetLink(uid: number) {
  const token = `stored-reset-token-${++sequence}`
  const now = Date.now()
  await db()
    .insertInto('verifications')
    .values({
      identifier: `reset-password:${token}`,
      value: String(uid),
      expires_at: writeAuthDate(db(), toIsoTimestamp(new Date(now + 3_600_000))),
      created_at: writeAuthDate(db(), toIsoTimestamp(new Date(now))),
      updated_at: writeAuthDate(db(), toIsoTimestamp(new Date(now))),
    })
    .execute()
  return token
}
const reset = (token: string) =>
  new Browser(core).request('/api/auth/reset-password', { token, newPassword: 'chosen by whoever holds the link' })
async function expectResetInvalid(token: string) {
  const response = await reset(token)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'INVALID_TOKEN' })
}

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
const notices = async () => (await mails()).filter((mail) => mail.template === 'adminAccountChanged')
/** 发给 to 的改邮箱确认链接里的令牌 */
async function confirmLinks(to: string) {
  return (await mails())
    .filter((mail) => mail.template === 'confirmEmailChange' && mail.to === to)
    .map((mail) => new URL(mail.url!).searchParams.get('token')!)
}
const profileEvents = async (uid: number) =>
  (await db().selectFrom('jobs').select('payload').where('name', '=', 'test:profile').orderBy('id').execute())
    .map(
      (row) => JSON.parse(row.payload) as { actor: Record<string, unknown>; data: { uid: number; fields: string[] } },
    )
    .filter((event) => event.data.uid === uid)
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
async function version(uid: number) {
  return (await db().selectFrom('users').select('email_version').where('id', '=', uid).executeTakeFirstOrThrow())
    .email_version
}

test('配置了邮件：发起时作废之前的改邮箱链接，确认链接发给新地址、通知发给旧地址；确认之前旧地址照旧能登录和找回', async () => {
  await configureMail()
  const target = await user('target')
  // 用户自己发起、还没确认的改邮箱
  await core.users.changeEmail({ uid: target.uid }, { email: 'mine@example.test', password }, ROOT)
  const [own] = await confirmLinks('mine@example.test')
  const session = await signIn(target.email)
  const before = await version(target.uid)

  expect(await change(target.uid, ' NEW@Example.TEST ', false)).toEqual({
    status: 'pending',
    pendingEmail: 'new@example.test',
  })

  expect(await version(target.uid)).toBe(before + 1)
  await expect(core.users.confirmEmailChange(own!)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
  const links = await confirmLinks('new@example.test')
  expect(links).toHaveLength(1)
  expect((await mails()).find((mail) => mail.to === 'new@example.test')?.url).toMatch(
    /^http:\/\/localhost:3000\/confirm-email\?token=/,
  )
  expect(await notices()).toMatchObject([
    {
      template: 'adminAccountChanged',
      to: target.email,
      uid: target.uid,
      changes: [{ kind: 'email', pending: true }],
    },
  ])
  // verified 不起作用，审计里也没有它
  expect(await audits(target.uid)).toEqual([
    {
      action: 'user.setEmail',
      actor: admin.uid,
      ip: admin.ip,
      details: { nickname: 'target', from: target.email, to: 'new@example.test', pending: true },
    },
  ])
  expect(await profileEvents(target.uid)).toEqual([])

  // 确认之前：邮箱、验证状态都没变，不退出登录，旧地址照旧能登录和找回
  expect(await core.users.profile(target.uid)).toMatchObject({ email: target.email, emailVerified: true })
  expect(await session.session()).toMatchObject({ uid: target.uid })
  expect((await attempt(target.email)).status).toBe(200)
  await requestReset(target.email, target.uid)
})

test('配置了邮件：用户确认之后生效、算已验证、版本再加一，之前签发的找回链接失效；事件的 actor 是点确认的用户本人', async () => {
  await configureMail()
  const target = await user('target')
  await db().updateTable('users').set({ email_verified: false }).where('id', '=', target.uid).execute()
  const resetBefore = await requestReset(target.email, target.uid)
  const before = await version(target.uid)
  await change(target.uid, 'new@example.test')
  const resetDuring = await requestReset(target.email, target.uid)
  const [link] = await confirmLinks('new@example.test')

  expect(await core.users.confirmEmailChange(link!)).toEqual({ email: 'new@example.test' })

  expect(await core.users.profile(target.uid)).toMatchObject({ email: 'new@example.test', emailVerified: true })
  expect(await version(target.uid)).toBe(before + 2)
  expect(await profileEvents(target.uid)).toEqual([
    expect.objectContaining({
      actor: { kind: 'user', uid: target.uid, role: 'user' },
      data: { uid: target.uid, fields: ['email'] },
    }),
  ])
  expect((await mails()).filter((mail) => mail.template === 'emailChanged')).toEqual([
    { template: 'emailChanged', to: target.email, uid: target.uid },
  ])
  for (const token of [resetBefore, resetDuring]) await expectResetInvalid(token)
  expect((await attempt(target.email)).status).toBe(401)
  expect((await attempt('new@example.test')).status).toBe(200)
  await expect(core.users.confirmEmailChange(link!)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
})

test('重新发起之后，前一条确认链接失效', async () => {
  await configureMail()
  const target = await user('target')
  await change(target.uid, 'typo@example.test')
  await change(target.uid, 'right@example.test')
  const [typo] = await confirmLinks('typo@example.test')
  const [right] = await confirmLinks('right@example.test')
  await expect(core.users.confirmEmailChange(typo!)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
  expect(await core.users.confirmEmailChange(right!)).toEqual({ email: 'right@example.test' })
  expect((await audits(target.uid)).map((row) => row.details)).toEqual([
    { nickname: 'target', from: target.email, to: 'typo@example.test', pending: true },
    { nickname: 'target', from: target.email, to: 'right@example.test', pending: true },
  ])
  expect((await notices()).map((mail) => mail.changes)).toEqual([
    [{ kind: 'email', pending: true }],
    [{ kind: 'email', pending: true }],
  ])
})

test('配置了邮件时对象被封禁返回 user_banned，不写审计、不发通知、版本不变；没有配置邮件时被封禁也能改', async () => {
  await configureMail()
  const target = await user('target', 'banned')
  const before = await version(target.uid)
  await expect(change(target.uid, 'new@example.test')).rejects.toMatchObject({ code: 'user_banned' })
  expect(await version(target.uid)).toBe(before)
  expect(await mails()).toEqual([])
  expect(await audits(target.uid)).toEqual([])
  await setting('mail.transport', 'none')
  expect(await change(target.uid, 'new@example.test')).toMatchObject({
    status: 'changed',
    user: { uid: target.uid, email: 'new@example.test', role: 'banned' },
  })
})

test.each([
  { verified: true, expected: true },
  { verified: false, expected: false },
  { verified: undefined, expected: false },
])(
  '没有配置邮件：立即生效（verified: $verified）；版本加一、找回链接作废、不退出登录；事件的 actor 是管理员',
  async ({ verified, expected }) => {
    const target = await user('target')
    const bystander = await user('bystander')
    const session = await signIn(target.email)
    const before = await version(target.uid)
    // 站点之前配置过邮件时签发、还没用的改邮箱链接和找回链接
    const own = createEmailChangeTokens(secretKey).sign({
      uid: target.uid,
      emailVersion: before,
      oldEmail: target.email,
      newEmail: 'mine@example.test',
      expiresAt: Date.now() + 3_600_000,
    })
    const resetToken = await storedResetLink(target.uid)
    const otherReset = await storedResetLink(bystander.uid)

    const result = await change(target.uid, ' NEW@Example.TEST ', verified)

    expect(result).toEqual({
      status: 'changed',
      user: expect.objectContaining({ uid: target.uid, email: 'new@example.test', emailVerified: expected }) as unknown,
    })
    expect(await core.users.profile(target.uid)).toMatchObject({ email: 'new@example.test', emailVerified: expected })
    expect(await version(target.uid)).toBe(before + 1)
    await expect(core.users.confirmEmailChange(own)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
    await expectResetInvalid(resetToken)
    expect(await session.session()).toMatchObject({ uid: target.uid, email: 'new@example.test' })
    expect(await profileEvents(target.uid)).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', uid: admin.uid, role: 'admin' },
        data: { uid: target.uid, fields: ['email'] },
      }),
    ])
    expect(await audits(target.uid)).toEqual([
      {
        action: 'user.setEmail',
        actor: admin.uid,
        ip: admin.ip,
        details: { nickname: 'target', from: target.email, to: 'new@example.test', pending: false, verified: expected },
      },
    ])
    expect(await mails()).toEqual([])
    // 别人的找回链接不受影响：也说明上面写进去的链接格式是对的
    expect((await reset(otherReset)).status).toBe(200)
    expect((await attempt('new@example.test')).status).toBe(200)
  },
)

test('格式、转小写和唯一照注册的规则校验，不查邮箱域名的名单；失败时不写审计', async () => {
  const target = await user('target')
  await user('taken')
  for (const email of ['invalid', `${'a'.repeat(250)}@example.test`])
    await expect(change(target.uid, email)).rejects.toMatchObject({ code: 'email_invalid' })
  await expect(change(target.uid, ' TARGET@EXAMPLE.TEST ')).rejects.toMatchObject({ code: 'email_unchanged' })
  await expect(change(target.uid, 'Taken@Example.Test')).rejects.toMatchObject({ code: 'email_taken' })
  expect(await audits(target.uid)).toEqual([])
  await setting('auth.registration.emailDomains', { mode: 'deny', domains: ['example.test'] })
  expect(await change(target.uid, 'denied@example.test')).toMatchObject({ status: 'changed' })
  await setting('auth.registration.emailDomains', { mode: 'allow', domains: ['allowed.test'] })
  expect(await change(target.uid, 'outside@example.test')).toMatchObject({ status: 'changed' })
  expect((await audits(target.uid)).map((row) => row.action)).toEqual(['user.setEmail', 'user.setEmail'])
})

test('两个请求并发把两个用户改成同一个邮箱，只有一个成功，另一个 email_taken', async () => {
  const first = await user('first')
  const second = await user('second')
  const results = await Promise.allSettled([first, second].map(({ uid }) => change(uid, 'same@example.test')))
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toMatchObject([{ reason: { code: 'email_taken' } }])
  expect(await countRows(db().selectFrom('users').where('email', '=', 'same@example.test'))).toBe(1)
  expect((await audits(first.uid)).length + (await audits(second.uid)).length).toBe(1)
})

/**
 * 让事务里"邮箱有没有被别人占用"的检查什么也查不到，相当于占用它的那个事务那时还没提交（READ COMMITTED）：
 * 之后的 UPDATE 才撞上唯一索引。四种库上都能确定地走到事务外的转换
 */
function hideEmailCheck(): KyselyPlugin {
  const hidden = new Set<QueryId>()
  return {
    transformQuery({ node, queryId }) {
      if (node.kind === 'SelectQueryNode') {
        const text = JSON.stringify(node, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value))
        if (text.includes('"users"') && text.includes('"email"') && text.includes('"!="')) hidden.add(queryId)
      }
      return node
    },
    transformResult({ result, queryId }) {
      return Promise.resolve(hidden.delete(queryId) ? { ...result, rows: [] } : result)
    },
  }
}

test('唯一检查没挡住、UPDATE 才撞上唯一索引时，改邮箱和收回账号都在事务外转成 email_taken，什么也不改', async () => {
  const target = await user('target')
  await user('taken')
  const before = await version(target.uid)
  const subject = createCore({
    db: db().withPlugin(hideEmailCheck()),
    secretKey,
    production: false,
    textureStorage: storage,
  })
  try {
    await expect(
      subject.admin.changeUserEmail(admin, target.uid, { email: 'taken@example.test' }, ROOT),
    ).rejects.toMatchObject({ code: 'email_taken' })
    // 收回账号第一次撞上时整个用例重跑，重跑又撞上才转换
    await expect(
      subject.admin.setUserPassword(admin, target.uid, {
        password: 'issued by the administrator',
        newEmail: 'taken@example.test',
      }),
    ).rejects.toMatchObject({ code: 'email_taken' })
  } finally {
    await subject.shutdown()
  }
  expect(
    await db().selectFrom('users').select(['email', 'email_version']).where('id', '=', target.uid).executeTakeFirst(),
  ).toEqual({ email: target.email, email_version: before })
  expect((await attempt(target.email)).status).toBe(200)
  expect(await audits(target.uid)).toEqual([])
  expect(await mails()).toEqual([])
})

test('配置了邮件却没有站点地址：生产环境拒绝签发，开发环境退回请求的地址', async () => {
  await configureMail(null)
  const target = await user('target')
  const before = await version(target.uid)
  const production = createCore({ db: db(), secretKey, production: true, textureStorage: storage })
  await expect(
    production.admin.changeUserEmail(admin, target.uid, { email: 'new@example.test' }, ROOT),
  ).rejects.toThrow('site_url_required')
  expect(await version(target.uid)).toBe(before)
  expect(await mails()).toEqual([])
  expect(await audits(target.uid)).toEqual([])
  await change(target.uid, 'new@example.test', undefined, 'http://dev.example.test:3000')
  expect((await mails()).find((mail) => mail.template === 'confirmEmailChange')?.url).toMatch(
    /^http:\/\/dev\.example\.test:3000\/confirm-email\?token=/,
  )
})

test('通知入队失败时整体回滚：版本不变、没有审计', async () => {
  await configureMail()
  const target = await user('target')
  const before = await version(target.uid)
  const enqueue = core.jobs.enqueue.bind(core.jobs)
  const spy = vi.spyOn(core.jobs, 'enqueue').mockImplementation((tx, name, payload, options) => {
    if (name === MAIL_JOB) throw new Error('enqueue_failed')
    return enqueue(tx, name, payload, options)
  })
  try {
    await expect(change(target.uid, 'new@example.test')).rejects.toThrow('enqueue_failed')
  } finally {
    spy.mockRestore()
  }
  expect(await version(target.uid)).toBe(before)
  expect(await audits(target.uid)).toEqual([])
  expect(await core.users.profile(target.uid)).toMatchObject({ email: target.email })
})
