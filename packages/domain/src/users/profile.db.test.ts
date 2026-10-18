import {
  coreMigrations,
  countRows,
  insertReturningId,
  migrateToLatest,
  readAuthBoolean,
  toIsoTimestamp,
  transactionWithRetry,
  upsert,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import type { KyselyPlugin, QueryId } from 'kysely'
import { hashPassword } from 'better-auth/crypto'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import {
  createCore,
  encodeSettingValue,
  type Core,
  type CoreSettingKey,
  type CoreSettingValue,
  type UserRole,
} from '../index.ts'
import { adjustScore } from '../score/adjust.ts'
import { MAIL_JOB } from '../mail/service.ts'
import { createEmailChangeTokens } from './email-change-token.ts'

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const password = 'correct horse battery staple'
const old = toIsoTimestamp(new Date('2020-01-01T00:00:00Z'))
const root = 'http://localhost:3000'
let database: TestDatabase<CoreDatabase>
let core: Core
let actor: { uid: number }
let hash: string
const db = () => database.db
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
  hash = await hashPassword(password)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db().deleteFrom('users').execute()
  await db().deleteFrom('jobs').execute()
  await db().deleteFrom('settings').execute()
  core = createCore({
    db: db(),
    secretKey,
    production: false,
    textureStorage: {
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
    mailTransport: { send: () => Promise.resolve({ messageId: null }) },
  })
  actor = await user('owner')
  core.events.subscribe('user.profileUpdated', 'test:profile', { run: () => Promise.resolve() })
})
async function user(name: string, role: UserRole = 'user') {
  const now = writeAuthDate(db(), old)
  const uid = await insertReturningId(db(), 'users', {
    nickname: name,
    email: `${name}@example.test`,
    role,
    email_verified: true,
    locale: 'zh-CN',
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
  await transactionWithRetry(db(), (tx) =>
    adjustScore(tx, { uid, delta: 1000, reason: 'score.reasons.initial', now: old }),
  )
  return { uid }
}
async function setting<K extends CoreSettingKey>(key: K, value: CoreSettingValue<K>) {
  await upsert(db(), 'settings', {
    values: { namespace: 'core', key, value: encodeSettingValue(key, value, { secretKey }), updated_at: old },
    conflict: ['namespace', 'key'],
    update: ['value', 'updated_at'],
  })
}
async function configureMail() {
  await setting('mail.transport', 'smtp')
  await setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
}
const profile = () => core.users.profile(actor.uid)
const change = (email: string, value = password) => core.users.changeEmail(actor, { email, password: value }, root)
interface MailPayload {
  template: string
  to: string
  uid: number
  url?: string
  expiresAt?: string
}
const mails = async () =>
  (await db().selectFrom('jobs').select('payload').where('name', '=', MAIL_JOB).orderBy('id').execute()).map(
    (row) => JSON.parse(row.payload) as MailPayload,
  )
const events = async () =>
  (await db().selectFrom('jobs').select('payload').where('name', '=', 'test:profile').orderBy('id').execute()).map(
    (row) => JSON.parse(row.payload) as { data: { uid: number; fields: string[] } },
  )
async function token(email = 'new@example.test') {
  await change(email)
  const job = (await mails()).at(-1)!
  return new URL(job.url!).searchParams.get('token')!
}

test('profile 完整映射 PrivateUser；deletionImpact 只数本人角色和 OAuth 应用', async () => {
  expect(await profile()).toEqual({
    uid: actor.uid,
    nickname: 'owner',
    role: 'user',
    avatarTid: null,
    registeredAt: old,
    email: 'owner@example.test',
    emailVerified: true,
    score: 1000,
    locale: 'zh-CN',
  })
  expect(await core.users.profile(2147483647)).toBeNull()
  expect(await core.users.deletionImpact(actor.uid)).toEqual({ players: 0, oauthClients: 0 })
  const other = await user('other')
  await core.players.create(actor, { name: 'Steve' })
  await core.players.create(other, { name: 'Alex' })
  for (const uid of [actor.uid, other.uid])
    await db()
      .insertInto('oauth_clients')
      .values({ client_id: `client-${uid}`, user_id: uid, redirect_uris: '[]' })
      .execute()
  expect(await core.users.deletionImpact(actor.uid)).toEqual({ players: 1, oauthClients: 1 })
  expect(await core.users.deletionImpact(2147483647)).toEqual({ players: 0, oauthClients: 0 })
})

test('昵称按码位 trim；只发真正变化的 fields，无变化不发事件', async () => {
  const nickname = '😀'.repeat(255)
  expect((await core.users.updateProfile(actor, { nickname: ` ${nickname} `, locale: 'en' })).nickname).toBe(nickname)
  expect((await events()).map((e) => e.data)).toEqual([{ uid: actor.uid, fields: ['nickname', 'locale'] }])
  await core.users.updateProfile(actor, { nickname, locale: 'en' })
  await core.users.updateProfile(actor, {})
  expect(await events()).toHaveLength(1)
  await core.users.updateProfile(actor, { nickname, locale: 'zh-CN' })
  await core.users.updateProfile(actor, { nickname: '新昵称' })
  expect((await events()).map((e) => e.data.fields)).toEqual([['nickname', 'locale'], ['locale'], ['nickname']])
})

test('昵称和语言规则；不存在或封禁用户不能更新', async () => {
  for (const nickname of ['', '  ', '😀'.repeat(256)])
    await expect(core.users.updateProfile(actor, { nickname })).rejects.toMatchObject({
      code: 'nickname_invalid',
      params: { min: 1, max: 255 },
    })
  for (const locale of ['en-US', 'zh', 'EN', ' en', 'fr', ''])
    await expect(core.users.updateProfile(actor, { locale })).rejects.toMatchObject({ code: 'locale_invalid' })
  await expect(core.users.updateProfile({ uid: 2147483647 }, {})).rejects.toMatchObject({ code: 'unauthenticated' })
  await db().updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
  await expect(core.users.updateProfile(actor, { nickname: 'Other' })).rejects.toMatchObject({ code: 'user_banned' })
  expect(await events()).toEqual([])
})

test('密码错误、没有 credential 或密码为空都不能改邮箱或删除', async () => {
  const call = async () => {
    await expect(change('new@example.test', 'wrong')).rejects.toMatchObject({ code: 'password_incorrect' })
    await expect(core.users.deleteAccount(actor, { password: 'wrong' })).rejects.toMatchObject({
      code: 'password_incorrect',
    })
  }
  await call()
  await db().updateTable('accounts').set({ password: null }).where('user_id', '=', actor.uid).execute()
  await expect(change('new@example.test')).rejects.toMatchObject({ code: 'password_incorrect' })
  await db().deleteFrom('accounts').where('user_id', '=', actor.uid).execute()
  await expect(core.users.deleteAccount(actor, { password })).rejects.toMatchObject({ code: 'password_incorrect' })
})

test('邮箱格式、长度、域名名单、相同和占用与注册共用规则', async () => {
  await user('taken')
  for (const email of ['invalid', `${'a'.repeat(250)}@example.test`])
    await expect(change(email)).rejects.toMatchObject({ code: 'email_invalid' })
  await expect(change(' OWNER@EXAMPLE.TEST ')).rejects.toMatchObject({ code: 'email_unchanged' })
  await expect(change('taken@example.test')).rejects.toMatchObject({ code: 'email_taken' })
  await setting('auth.registration.emailDomains', { mode: 'allow', domains: ['allowed.test'] })
  await expect(change('new@example.test')).rejects.toMatchObject({ code: 'email_domain_not_allowed' })
  await setting('auth.registration.emailDomains', { mode: 'deny', domains: ['example.test'] })
  await expect(change('new@example.test')).rejects.toMatchObject({ code: 'email_domain_not_allowed' })
  expect(await events()).toEqual([])
})

test('没配置邮件立即修改并清验证状态，不退会话；旧格式密码核对不重新哈希', async () => {
  const legacy = '$bs$salted2sha256$a99c25c7b8f53925aedf19fe78ccd0838ecb44f54baa455289c36798a80b07eb'
  await setting('auth.legacyPasswordSalt', 'bs-salt-中文')
  await db().updateTable('accounts').set({ password: legacy }).where('user_id', '=', actor.uid).execute()
  const result = await change(' NEW@Example.TEST ', 'php-era-password')
  expect(result).toEqual({
    status: 'changed',
    user: { ...(await profile()), email: 'new@example.test', emailVerified: false },
  })
  expect((await profile())?.emailVerified).toBe(false)
  expect(
    (await db().selectFrom('accounts').select('password').where('user_id', '=', actor.uid).executeTakeFirstOrThrow())
      .password,
  ).toBe(legacy)
  expect((await events()).map((e) => e.data.fields)).toEqual([['email']])
  expect(await mails()).toEqual([])
})

test('配置邮件只给新地址入队；确认与事件、旧地址通知一起提交，链接只能用一次', async () => {
  await configureMail()
  await setting('site.url', 'https://skin.example.test///')
  await db().updateTable('users').set({ email_verified: false }).where('id', '=', actor.uid).execute()
  const before = await profile()
  const link = await token(' NEW@Example.TEST ')
  expect(await profile()).toEqual(before)
  expect(await events()).toEqual([])
  expect(await mails()).toMatchObject([
    {
      template: 'confirmEmailChange',
      to: 'new@example.test',
      uid: actor.uid,
      url: expect.stringMatching(/^https:\/\/skin.example.test\/confirm-email\?token=/) as unknown,
    },
  ])
  const expiresAt = new Date((await mails())[0]!.expiresAt!).getTime()
  expect(expiresAt - Date.now()).toBeGreaterThan(3_590_000)
  expect(expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000)
  expect(await core.users.previewEmailChange(link)).toEqual({ email: 'new@example.test' })
  expect(await core.users.confirmEmailChange(link)).toEqual({ email: 'new@example.test' })
  expect(await profile()).toMatchObject({ email: 'new@example.test', emailVerified: true })
  expect((await events()).map((e) => e.data.fields)).toEqual([['email']])
  expect((await mails())[1]).toEqual({ template: 'emailChanged', to: 'owner@example.test', uid: actor.uid })
  await expect(core.users.confirmEmailChange(link)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
  expect(await core.users.previewEmailChange(link)).toBeNull()
})

test('同一旧邮箱下多个链接只有先确认的有效；并发确认同样只提交一次', async () => {
  await configureMail()
  const first = await token('first@example.test')
  const second = await token('second@example.test')
  const results = await Promise.allSettled([
    core.users.confirmEmailChange(first),
    core.users.confirmEmailChange(second),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toMatchObject([
    { reason: { code: 'email_change_link_invalid' } },
  ])
  expect(await core.users.previewEmailChange(first)).toBeNull()
  expect(await core.users.previewEmailChange(second)).toBeNull()
  expect(await events()).toHaveLength(1)
  expect((await mails()).filter((m) => m.template === 'emailChanged')).toHaveLength(1)
})

test('确认前新邮箱被占用：唯一冲突在事务外转换，邮箱、验证状态、事件和通知都不变', async () => {
  await configureMail()
  const link = await token('taken@example.test')
  await user('taken')
  const before = await profile()
  await expect(core.users.confirmEmailChange(link)).rejects.toMatchObject({ code: 'email_taken' })
  expect(await profile()).toEqual(before)
  expect(await events()).toEqual([])
  expect(await mails()).toHaveLength(1)
  expect(await core.users.previewEmailChange(link)).toEqual({ email: 'taken@example.test' })
})

test('无效格式、篡改、过期的令牌不能预览或确认；用户删除后也无效', async () => {
  await configureMail()
  const link = await token()
  const tokens = createEmailChangeTokens(secretKey)
  const expired = tokens.sign({
    uid: actor.uid,
    emailVersion: 0,
    oldEmail: 'owner@example.test',
    newEmail: 'new@example.test',
    expiresAt: Date.now() - 1,
  })
  const tampered = link.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))
  for (const value of ['', 'a.b.c', 'a.b', link + '!', link.slice(0, -4) + 'aaaa', tampered, expired]) {
    expect(await core.users.previewEmailChange(value)).toBeNull()
    await expect(core.users.confirmEmailChange(value)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
  }
  await db().deleteFrom('users').where('id', '=', actor.uid).execute()
  expect(await core.users.previewEmailChange(link)).toBeNull()
  await expect(core.users.confirmEmailChange(link)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
})

test('封禁用户不能申请、确认邮箱或删除账号；管理员和超级管理员不能自删', async () => {
  await configureMail()
  const link = await token()
  await db().updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
  for (const call of [
    () => change('next@example.test'),
    () => core.users.confirmEmailChange(link),
    () => core.users.deleteAccount(actor, { password }),
  ])
    await expect(call()).rejects.toMatchObject({ code: 'user_banned' })
  for (const role of ['admin', 'superadmin'] as const) {
    await db().updateTable('users').set({ role }).where('id', '=', actor.uid).execute()
    await expect(core.users.deleteAccount(actor, { password })).rejects.toMatchObject({
      code: 'admin_cannot_delete_self',
    })
  }
  expect((await profile())?.email).toBe('owner@example.test')
})

test('通知入队失败会回滚邮箱和事件', async () => {
  await configureMail()
  const link = await token()
  const enqueue = core.jobs.enqueue.bind(core.jobs)
  const spy = vi.spyOn(core.jobs, 'enqueue').mockImplementation((tx, name, payload, options) => {
    if (name === MAIL_JOB) throw new Error('enqueue_failed')
    return enqueue(tx, name, payload, options)
  })
  try {
    await expect(core.users.confirmEmailChange(link)).rejects.toThrow('enqueue_failed')
  } finally {
    spy.mockRestore()
  }
  expect((await profile())?.email).toBe('owner@example.test')
  expect(await events()).toEqual([])
  expect(await mails()).toHaveLength(1)
})

test('生产环境已配置邮件却没有站点地址时拒绝签发，开发环境回退 requestRoot', async () => {
  await configureMail()
  const production = createCore({
    db: db(),
    secretKey,
    production: true,
    textureStorage: {
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
  })
  await expect(production.users.changeEmail(actor, { email: 'new@example.test', password }, root)).rejects.toThrow(
    'site_url_required',
  )
  await change('new@example.test')
  expect((await mails())[0]?.url).toMatch(/^http:\/\/localhost:3000\/confirm-email\?token=/)
})

test('删除级联清会话、密码、两步验证、通行密钥、OAuth 和积分，每个角色与用户都有事件，不影响别人', async () => {
  const other = await user('other')
  const players = [
    await core.players.create(actor, { name: 'Steve' }),
    await core.players.create(actor, { name: 'Alex' }),
  ]
  await core.players.create(other, { name: 'Other' })
  const now = writeAuthDate(db(), old)
  for (const uid of [actor.uid, other.uid]) {
    await db()
      .insertInto('sessions')
      .values({
        user_id: uid,
        token: `session-${uid}`,
        created_at: now,
        updated_at: now,
        expires_at: now,
        ip_address: null,
        user_agent: null,
      })
      .execute()
    await db()
      .insertInto('two_factors')
      .values({
        user_id: uid,
        secret: 'test-secret',
        backup_codes: 'test-codes',
        verified: true,
        failed_verification_count: 0,
        locked_until: null,
      })
      .execute()
    await db()
      .insertInto('passkeys')
      .values({
        user_id: uid,
        name: 'Key',
        public_key: 'test-key',
        credential_id: `key-${uid}`,
        counter: 0,
        device_type: 'multiDevice',
        backed_up: true,
        transports: null,
        created_at: now,
        aaguid: null,
      })
      .execute()
    await db()
      .insertInto('oauth_clients')
      .values({ user_id: uid, client_id: `client-${uid}`, redirect_uris: '[]' })
      .execute()
    const refreshId = await insertReturningId(db(), 'oauth_refresh_tokens', {
      user_id: uid,
      client_id: `client-${uid}`,
      token: `refresh-${uid}`,
      scopes: '[]',
      expires_at: now,
      created_at: now,
    })
    await db()
      .insertInto('oauth_access_tokens')
      .values({
        user_id: uid,
        client_id: `client-${uid}`,
        token: `access-${uid}`,
        refresh_id: refreshId,
        scopes: '[]',
        expires_at: now,
        created_at: now,
      })
      .execute()
    await db()
      .insertInto('oauth_consents')
      .values({ user_id: uid, client_id: `client-${uid}`, scopes: '[]', created_at: now, updated_at: now })
      .execute()
  }
  core.events.subscribe('player.deleted', 'test:player-deleted', { run: () => Promise.resolve() })
  core.events.subscribe('user.deleted', 'test:user-deleted', { run: () => Promise.resolve() })
  await core.users.deleteAccount(actor, { password })
  expect(await profile()).toBeNull()
  for (const table of [
    'players',
    'sessions',
    'accounts',
    'two_factors',
    'passkeys',
    'score_transactions',
    'oauth_clients',
    'oauth_refresh_tokens',
    'oauth_access_tokens',
    'oauth_consents',
  ] as const) {
    expect(await countRows(db().selectFrom(table).where('user_id', '=', actor.uid))).toBe(0)
    expect(await countRows(db().selectFrom(table).where('user_id', '=', other.uid))).toBeGreaterThan(0)
  }
  const jobs = await db().selectFrom('jobs').select(['name', 'payload']).orderBy('id').execute()
  expect(jobs.map((j) => ({ name: j.name, event: JSON.parse(j.payload) as unknown }))).toEqual([
    ...players.map((p) => ({
      name: 'test:player-deleted',
      event: expect.objectContaining({
        actor: { kind: 'user', uid: actor.uid, role: 'user' },
        data: { pid: p.pid, uid: actor.uid, name: p.name, uuid: p.uuid },
      }) as unknown,
    })),
    { name: 'test:user-deleted', event: expect.objectContaining({ data: { uid: actor.uid } }) as unknown },
  ])
})

test('security 未开启两步验证返回 null 备用码数量，通行密钥字段经过 BA 转换并排序', async () => {
  const other = await user('other')
  expect(await core.auth.security(actor.uid)).toEqual({
    twoFactorEnabled: false,
    backupCodesRemaining: null,
    passkeys: [],
  })
  for (const [uid, name, time, backedUp] of [
    [actor.uid, 'Later', '2021-01-01T00:00:00Z', true],
    [actor.uid, null, '2020-01-01T00:00:00Z', false],
    [other.uid, 'Other', '2020-01-01T00:00:00Z', true],
  ] as const) {
    await db()
      .insertInto('passkeys')
      .values({
        user_id: uid,
        name,
        public_key: 'test-key',
        credential_id: `${uid}-${time}`,
        counter: 0,
        device_type: 'multiDevice',
        backed_up: backedUp,
        transports: null,
        created_at: writeAuthDate(db(), toIsoTimestamp(new Date(time))),
        aaguid: null,
      })
      .execute()
  }
  expect((await core.auth.security(actor.uid)).passkeys).toEqual([
    { id: expect.any(String) as unknown, name: null, createdAt: old, backedUp: false, deviceType: 'multiDevice' },
    {
      id: expect.any(String) as unknown,
      name: 'Later',
      createdAt: '2021-01-01T00:00:00.000Z',
      backedUp: true,
      deviceType: 'multiDevice',
    },
  ])
  await db().updateTable('users').set({ two_factor_enabled: true }).where('id', '=', actor.uid).execute()
  expect(
    readAuthBoolean(
      (
        await db()
          .selectFrom('users')
          .select('two_factor_enabled')
          .where('id', '=', actor.uid)
          .executeTakeFirstOrThrow()
      ).two_factor_enabled,
    ),
  ).toBe(true)
  const production = createCore({
    db: db(),
    secretKey,
    production: true,
    textureStorage: {
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
  })
  expect((await production.auth.security(actor.uid)).backupCodesRemaining).toBeNull()
})

test('链接真正经过一小时后预览和确认都失效；未知用户不能改邮箱或自删', async () => {
  await configureMail()
  const link = await token()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001)
  try {
    expect(await core.users.previewEmailChange(link)).toBeNull()
    await expect(core.users.confirmEmailChange(link)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
  } finally {
    clock.mockRestore()
  }
  await expect(
    core.users.changeEmail({ uid: 2147483647 }, { email: 'new@example.test', password }, root),
  ).rejects.toMatchObject({ code: 'unauthenticated' })
  await expect(core.users.deleteAccount({ uid: 2147483647 }, { password })).rejects.toMatchObject({
    code: 'unauthenticated',
  })
})

test('删除事件写入失败会回滚角色、用户和积分流水', async () => {
  await core.players.create(actor, { name: 'Steve' })
  core.events.subscribe('user.deleted', 'test:user-deleted', { run: () => Promise.resolve() })
  const spy = vi.spyOn(core.jobs, 'enqueue').mockRejectedValue(new Error('event_failed'))
  try {
    await expect(core.users.deleteAccount(actor, { password })).rejects.toThrow('event_failed')
  } finally {
    spy.mockRestore()
  }
  expect(await profile()).not.toBeNull()
  expect(await countRows(db().selectFrom('players').where('user_id', '=', actor.uid))).toBe(1)
  expect(await countRows(db().selectFrom('score_transactions').where('user_id', '=', actor.uid))).toBe(2)
})

test.each(['confirm', 'direct'] as const)('改回原邮箱后旧链接永久失效（%s），预览也不再接受', async (back) => {
  await configureMail()
  const original = await token('new@example.test')
  const unused = await token('unused@example.test')
  expect(await emailVersion()).toBe(0)
  await core.users.confirmEmailChange(original)
  expect(await emailVersion()).toBe(1)
  if (back === 'confirm') {
    const reverse = await token('owner@example.test')
    await core.users.confirmEmailChange(reverse)
  } else {
    await setting('mail.transport', 'none')
    await change('owner@example.test')
  }
  expect(await emailVersion()).toBe(2)
  const before = await profile()
  expect(before?.email).toBe('owner@example.test')
  const beforeEvents = await events()
  const beforeMails = await mails()
  for (const link of [original, unused]) {
    expect(await core.users.previewEmailChange(link)).toBeNull()
    await expect(core.users.confirmEmailChange(link)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
  }
  expect(await emailVersion()).toBe(2)
  expect(await profile()).toEqual(before)
  expect(await events()).toEqual(beforeEvents)
  expect(await mails()).toEqual(beforeMails)
})

test.each(['updateProfile', 'changeEmail', 'deleteAccount'] as const)(
  '封禁优先于输入校验和密码核对（%s）',
  async (operation) => {
    await db().updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
    const call = () =>
      operation === 'updateProfile'
        ? core.users.updateProfile(actor, { nickname: '', locale: 'unsupported' })
        : operation === 'changeEmail'
          ? core.users.changeEmail(actor, { email: 'invalid', password: 'wrong' }, root)
          : core.users.deleteAccount(actor, { password: 'wrong' })
    await expect(call()).rejects.toMatchObject({ code: 'user_banned' })
    expect(await events()).toEqual([])
    expect(await mails()).toEqual([])
  },
)

const emailVersion = async () =>
  (await db().selectFrom('users').select('email_version').where('id', '=', actor.uid).executeTakeFirstOrThrow())
    .email_version

test('邮箱版本只在修改邮箱时递增，申请、资料更新、失败的确认都不递增', async () => {
  expect(await emailVersion()).toBe(0)
  await core.users.updateProfile(actor, { nickname: 'Updated', locale: 'en' })
  expect(await emailVersion()).toBe(0)
  await configureMail()
  const first = await token('first@example.test')
  const second = await token('second@example.test')
  expect(createEmailChangeTokens(secretKey).parse(first)?.emailVersion).toBe(0)
  expect(await emailVersion()).toBe(0)
  await core.users.confirmEmailChange(first)
  expect(await emailVersion()).toBe(1)
  await expect(core.users.confirmEmailChange(second)).rejects.toMatchObject({ code: 'email_change_link_invalid' })
  expect(await core.users.previewEmailChange(second)).toBeNull()
  expect(await emailVersion()).toBe(1)
  const next = await token('third@example.test')
  expect(createEmailChangeTokens(secretKey).parse(next)?.emailVersion).toBe(1)
  await user('third')
  await expect(core.users.confirmEmailChange(next)).rejects.toMatchObject({ code: 'email_taken' })
  expect(await emailVersion()).toBe(1)
  await setting('mail.transport', 'none')
  await change('direct@example.test')
  expect(await emailVersion()).toBe(2)
})

/** 真实预读结束后提交封禁，再把原预读结果交给用例，确定地构造锁行前的交错。 */
function afterRoleReadOnce(run: () => Promise<void>): KyselyPlugin {
  let armed = true
  const pending = new Set<QueryId>()
  return {
    transformQuery({ node, queryId }) {
      const text = JSON.stringify(node)
      if (armed && node.kind === 'SelectQueryNode' && text.includes('"users"') && text.includes('"role"')) {
        armed = false
        pending.add(queryId)
      }
      return node
    },
    async transformResult({ result, queryId }) {
      if (pending.delete(queryId)) await run()
      return result
    },
  }
}

test.each(['updateProfile', 'changeEmail', 'deleteAccount'] as const)(
  '预读后才封禁，锁行后仍拒绝且不改数据或发事件（%s）',
  async (operation) => {
    await core.players.create(actor, { name: 'Steve' })
    const beforeUser = await db().selectFrom('users').selectAll().where('id', '=', actor.uid).executeTakeFirstOrThrow()
    const beforePlayers = await db().selectFrom('players').selectAll().execute()
    const beforeAccounts = await db().selectFrom('accounts').selectAll().execute()
    const beforeScores = await db().selectFrom('score_transactions').selectAll().orderBy('id').execute()
    const ban = vi.fn(async () => {
      await db().updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
    })
    const subject = createCore({
      db: db().withPlugin(afterRoleReadOnce(ban)),
      secretKey,
      production: false,
      textureStorage: {
        lateDeleteWindowMs: 0,
        write: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        deleteTemp: () => Promise.resolve(),
        read: () => Promise.resolve(null),
      },
    })
    for (const name of ['user.profileUpdated', 'user.deleted', 'player.deleted'] as const)
      subject.events.subscribe(name, `test:${name}`, { run: () => Promise.resolve() })
    const call = () =>
      operation === 'updateProfile'
        ? subject.users.updateProfile(actor, { nickname: 'Changed', locale: 'en' })
        : operation === 'changeEmail'
          ? subject.users.changeEmail(actor, { email: 'new@example.test', password }, root)
          : subject.users.deleteAccount(actor, { password })
    await expect(call()).rejects.toMatchObject({ code: 'user_banned' })
    expect(ban).toHaveBeenCalledOnce()
    expect(await db().selectFrom('users').selectAll().where('id', '=', actor.uid).executeTakeFirstOrThrow()).toEqual({
      ...beforeUser,
      role: 'banned',
    })
    expect(await db().selectFrom('players').selectAll().execute()).toEqual(beforePlayers)
    expect(await db().selectFrom('accounts').selectAll().execute()).toEqual(beforeAccounts)
    expect(await db().selectFrom('score_transactions').selectAll().orderBy('id').execute()).toEqual(beforeScores)
    expect(await db().selectFrom('jobs').selectAll().execute()).toEqual([])
  },
)
