import { captureLogs } from '@nextskin/logging'
import { markSiteInitialized } from '../setup/initialized.test-helper.ts'
import {
  coreMigrations,
  countRows,
  migrateToLatest,
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  upsert,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import type { EventEnvelope } from '@nextskin/plugin-sdk'
import * as passwordCrypto from 'better-auth/crypto'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import {
  createCore,
  DomainError,
  encodeSettingValue,
  type Core,
  type CoreSettingKey,
  type CoreSettingValue,
  type MailMessage,
} from '../index.ts'
import { offlineUuid } from '../players/create.ts'
import { missUuidPrecheckOnce } from '../players/uuid-race.test-helper.ts'
import { assertEmailVerified } from './email-verification.ts'
import type { RegisterInput } from './register.ts'

vi.mock('better-auth/crypto', { spy: true })

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const ROOT = 'http://localhost:3000'
const password = 'correct horse battery staple'
let database: TestDatabase<CoreDatabase>
let core: Core
const messages: MailMessage[] = []
const input = (overrides: Partial<RegisterInput> = {}): RegisterInput => ({
  email: 'steve@example.test',
  password,
  playerName: 'Steve',
  ip: '192.0.2.1',
  locale: 'en',
  ...overrides,
})

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await database.db.deleteFrom('users').execute()
  await database.db.deleteFrom('jobs').execute()
  await database.db.deleteFrom('settings').execute()
  await markSiteInitialized(database.db)
  messages.length = 0
  core = createCore({
    db: database.db,
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
    mailTransport: {
      send: async (message) => {
        // transport 能看到已提交的用户、账号和角色，发送发生在注册事务外。
        expect(await countRows(database.db.selectFrom('accounts'))).toBeGreaterThan(0)
        messages.push(message)
        return { messageId: 'fake' }
      },
    },
  })
})

async function setting<K extends CoreSettingKey>(key: K, value: CoreSettingValue<K>) {
  await upsert(database.db, 'settings', {
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
async function request(path: string, body?: unknown, cookie?: string) {
  return core.auth.handle(
    new Request(`${ROOT}/api/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin: ROOT,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    ROOT,
    null,
  )
}
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}
function mailUrl(message: MailMessage) {
  return new URL(message.text.match(/https?:\/\/\S+/u)![0])
}

async function rejected(
  code: string,
  overrides: Partial<RegisterInput> = {},
  params?: Record<string, string | number>,
) {
  await expect(core.users.register(input(overrides))).rejects.toMatchObject({ code, ...(params ? { params } : {}) })
  expect(await countRows(database.db.selectFrom('users'))).toBe(0)
  expect(await countRows(database.db.selectFrom('accounts'))).toBe(0)
  expect(await countRows(database.db.selectFrom('players'))).toBe(0)
}

test('注册写入与 Better Auth 相同的凭据行，可登录并读取会话；保留 locale、IP、初始积分', async () => {
  await setting('user.initialScore', 1234)
  const before = new Date()
  const { uid } = await core.users.register(input({ email: '  Steve@EXAMPLE.Test ', playerName: ' Steve ' }))
  expect(Number.isSafeInteger(uid)).toBe(true)
  const user = await database.db.selectFrom('users').selectAll().where('id', '=', uid).executeTakeFirstOrThrow()
  expect(user).toMatchObject({
    email: 'steve@example.test',
    nickname: 'Steve',
    role: 'user',
    score: 1234,
    registration_ip: '192.0.2.1',
    locale: 'en',
  })
  expect(readAuthBoolean(user.email_verified)).toBe(false)
  expect(new Date(readAuthDate(user.created_at)).getTime()).toBeGreaterThanOrEqual(before.getTime())
  expect(readAuthDate(user.updated_at)).toBe(readAuthDate(user.created_at))
  const account = await database.db
    .selectFrom('accounts')
    .selectAll()
    .where('user_id', '=', uid)
    .executeTakeFirstOrThrow()
  expect(account).toMatchObject({
    provider_id: 'credential',
    account_id: String(uid),
    access_token: null,
    refresh_token: null,
    id_token: null,
    scope: null,
    access_token_expires_at: null,
    refresh_token_expires_at: null,
  })
  expect(account.password).toBeTruthy()
  expect(account.password).not.toBe(password)
  expect(readAuthDate(account.created_at)).toBe(readAuthDate(user.created_at))
  const player = await database.db
    .selectFrom('players')
    .selectAll()
    .where('user_id', '=', uid)
    .executeTakeFirstOrThrow()
  expect(player).toMatchObject({
    name: 'Steve',
    name_key: 'steve',
    uuid: offlineUuid('Steve'),
    skin_texture_id: null,
    cape_texture_id: null,
    score_paid: 0,
  })
  expect(player.created_at).toBe(player.updated_at)
  expect(
    await database.db
      .selectFrom('score_transactions')
      .select(['delta', 'balance', 'reason'])
      .where('user_id', '=', uid)
      .execute(),
  ).toEqual([{ delta: 1234, balance: 1234, reason: 'score.reasons.initial' }])
  const login = await request('/sign-in/email', { email: 'STEVE@example.test', password })
  expect(login.status).toBe(200)
  expect(await core.auth.getSessionUser(new Headers({ cookie: cookies(login) }), ROOT)).toEqual({
    uid,
    email: 'steve@example.test',
    nickname: 'Steve',
    role: 'user',
    locale: 'en',
    sessionId: expect.any(Number) as unknown,
  })
  expect(messages).toEqual([])
})

test.each([
  ['email_invalid', { email: 'invalid' }, undefined],
  ['email_invalid', { email: `${'a'.repeat(250)}@example.test` }, undefined],
  ['password_too_short', { password: '1234567' }, { min: 8 }],
  ['password_too_long', { password: 'x'.repeat(129) }, { max: 128 }],
  ['player_name_required', { playerName: '  ' }, undefined],
  ['player_name_invalid', { playerName: 'bad name' }, { rule: 'official' }],
  ['player_name_length', { playerName: 'ab' }, { min: 3, max: 16 }],
  ['player_name_length', { playerName: 'a'.repeat(17) }, { min: 3, max: 16 }],
] as const)('拒绝 %s %j 且无写入', async (code, overrides, params) => {
  await rejected(code, overrides, params)
})

test('关闭注册先于输入校验；custom 正则配置错误有独立错误码', async () => {
  await setting('auth.registration.enabled', false)
  await rejected('registration_disabled', { email: 'invalid' })
  await setting('auth.registration.enabled', true)
  await setting('player.nameRule', 'custom')
  await setting('player.nameRegex', '[')
  await rejected('player_name_rule_misconfigured')
})

test('邮箱域名允许和禁止名单忽略大小写，设置存储时规范化', async () => {
  await setting('auth.registration.emailDomains', { mode: 'allow', domains: ['EXAMPLE.TEST'] })
  const stored = await database.db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', 'auth.registration.emailDomains')
    .executeTakeFirstOrThrow()
  expect(JSON.parse(stored.value)).toEqual({ mode: 'allow', domains: ['example.test'] })
  await rejected('email_domain_not_allowed', { email: 'steve@elsewhere.test' })
  await setting('auth.registration.emailDomains', { mode: 'deny', domains: ['EXAMPLE.TEST'] })
  await rejected('email_domain_not_allowed')
  await setting('auth.registration.emailDomains', { mode: 'deny', domains: ['elsewhere.test'] })
  await expect(core.users.register(input())).resolves.toHaveProperty('uid')
})

test('唯一索引拒绝大小写不同的邮箱和角色名，角色冲突回滚用户和账号', async () => {
  await core.users.register(input())
  await expect(core.users.register(input({ email: 'STEVE@EXAMPLE.TEST', playerName: 'Other' }))).rejects.toMatchObject({
    code: 'email_taken',
  })
  await expect(core.users.register(input({ email: 'other@example.test', playerName: 'sTeVe' }))).rejects.toMatchObject({
    code: 'player_name_taken',
  })
  for (const table of ['users', 'accounts', 'players'] as const)
    expect(await countRows(database.db.selectFrom(table))).toBe(1)
})

test('同一 IP 达到上限拒绝，0 不限', async () => {
  await setting('auth.registration.perIpLimit', 1)
  await core.users.register(input())
  const hash = vi.mocked(passwordCrypto.hashPassword)
  hash.mockClear()
  try {
    await expect(
      core.users.register(input({ email: 'other@example.test', playerName: 'Other' })),
    ).rejects.toMatchObject({
      code: 'ip_limit_reached',
      params: { limit: 1 },
    })
    expect(hash).not.toHaveBeenCalled()
  } finally {
    hash.mockClear()
  }
  await setting('auth.registration.perIpLimit', 0)
  await core.users.register(input({ email: 'other@example.test', playerName: 'Other' }))
  expect(await countRows(database.db.selectFrom('users'))).toBe(2)
})

test('不填写角色名时校验昵称、忽略传入角色名、不建角色，locale 可以为 null', async () => {
  await setting('auth.registration.withPlayerName', false)
  await rejected('nickname_invalid', { nickname: '   ' }, { min: 1, max: 255 })
  await rejected('nickname_invalid', { nickname: 'a'.repeat(256) }, { min: 1, max: 255 })
  const { uid } = await core.users.register(
    input({ nickname: ' Nick Name ', playerName: 'invalid name!', locale: null }),
  )
  expect(
    await database.db
      .selectFrom('users')
      .select(['nickname', 'locale'])
      .where('id', '=', uid)
      .executeTakeFirstOrThrow(),
  ).toEqual({ nickname: 'Nick Name', locale: null })
  expect(await countRows(database.db.selectFrom('players'))).toBe(0)
})

test('离线 UUID 已被改名角色占用时改用随机 v4；random 设置直接 v4', async () => {
  await core.users.register(input())
  await database.db.updateTable('players').set({ name: 'Renamed', name_key: 'renamed' }).execute()
  await core.users.register(input({ email: 'second@example.test' }))
  await setting('player.uuidAlgorithm', 'random')
  await core.users.register(input({ email: 'third@example.test', playerName: 'Third' }))
  const rows = await database.db.selectFrom('players').select(['name', 'uuid']).execute()
  expect(rows.find((row) => row.name === 'Renamed')?.uuid).toBe(offlineUuid('Steve'))
  for (const row of rows.filter((row) => row.name !== 'Renamed'))
    expect(row.uuid).toMatch(/^[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/)
})

test('离线 UUID 在预查之后才被改名的角色占上：注册重来一次，改用随机 UUID', async () => {
  await core.users.register(input())
  await database.db.updateTable('players').set({ name: 'Renamed', name_key: 'renamed' }).execute()
  core = createCore({
    db: database.db.withPlugin(missUuidPrecheckOnce()),
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
  })
  const { uid } = await core.users.register(input({ email: 'second@example.test' }))
  const player = await database.db
    .selectFrom('players')
    .select('uuid')
    .where('user_id', '=', uid)
    .executeTakeFirstOrThrow()
  expect(player.uuid).not.toBe(offlineUuid('Steve'))
  expect(await countRows(database.db.selectFrom('users'))).toBe(2)
})

test('user.registered 随注册事务提交，注册失败时不留任务；初始积分为 0 不写流水', async () => {
  const players: EventEnvelope<'player.created'>[] = []
  core.events.subscribe('player.created', 'test:on:player.created', {
    run: ({ event }) => {
      players.push(event)
      return Promise.resolve()
    },
  })
  const events: EventEnvelope<'user.registered'>[] = []
  core.events.subscribe('user.registered', 'test:on:user.registered', {
    run: ({ event }) => {
      events.push(event)
      return Promise.resolve()
    },
  })
  await setting('user.initialScore', 0)
  const { uid } = await core.users.register(input())
  await expect(core.users.register(input({ playerName: 'Other' }))).rejects.toMatchObject({ code: 'email_taken' })
  await core.jobs.drain()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    name: 'user.registered',
    actor: { kind: 'user', uid, role: 'user' },
    data: { user: { uid, nickname: 'Steve', role: 'user', avatarTid: null }, extra: {} },
  })
  expect(events[0]!.data.user.registeredAt).toBe(events[0]!.occurredAt)
  expect(players).toHaveLength(1)
  expect(players[0]).toMatchObject({
    name: 'player.created',
    actor: events[0]!.actor,
    occurredAt: events[0]!.occurredAt,
    data: { player: { uid, name: 'Steve', skin: null, cape: null, updatedAt: events[0]!.occurredAt } },
  })
  const owned = await core.players.listOwned(uid)
  expect(players[0]!.data.player).toMatchObject({ pid: owned[0]!.pid, uuid: owned[0]!.uuid })
  expect(await core.players.delete({ uid }, owned[0]!.pid)).toEqual({ refunded: 0 })
  expect(await countRows(database.db.selectFrom('jobs'))).toBe(0)
  const user = await database.db.selectFrom('users').select('score').where('id', '=', uid).executeTakeFirstOrThrow()
  expect(user.score).toBe(0)
  expect(await countRows(database.db.selectFrom('score_transactions'))).toBe(0)
})

test('验证邮件在提交后入队，Better Auth 接受链接并验证邮箱；缓存实例读取当前邮件设置', async () => {
  // 先创建缓存实例，再启用邮件。
  await request('/get-session')
  await configureMail()
  const { uid } = await core.users.register(input())
  await core.jobs.drain()
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({
    to: 'steve@example.test',
    subject: 'Verify your email for NextSkin',
    from: { address: 'sender@example.test', name: 'NextSkin' },
  })
  // 按收件人的语言渲染，验证链接 24 小时有效
  expect(messages[0]!.text).toContain('24 hours')
  const url = mailUrl(messages[0]!)
  expect((await core.auth.handle(new Request(url), ROOT, null)).status).toBeLessThan(400)
  const user = await database.db
    .selectFrom('users')
    .select('email_verified')
    .where('id', '=', uid)
    .executeTakeFirstOrThrow()
  expect(readAuthBoolean(user.email_verified)).toBe(true)
  await setting('mail.transport', 'none')
  expect((await request('/send-verification-email', { email: 'steve@example.test' })).status).toBe(503)
})

test('验证邮件签发或入队失败不回滚注册；缺少站点地址不使用请求 Host 签发令牌', async () => {
  await setting('mail.transport', 'smtp')
  await setting('mail.from', { address: 'sender@example.test', name: '' })
  const warn = captureLogs()
  try {
    await expect(core.users.register(input())).resolves.toHaveProperty('uid')
  } finally {
    warn.restore()
  }
  expect(messages).toEqual([])
})

test('验证邮件入队失败仍然注册成功，日志不包含邮件或令牌', async () => {
  await configureMail()
  const enqueue = vi.spyOn(core.mail, 'send').mockImplementation(() => {
    throw new Error('MAIL_TOKEN_CANARY')
  })
  const warn = captureLogs()
  try {
    await expect(core.users.register(input())).resolves.toHaveProperty('uid')
    expect(enqueue).toHaveBeenCalledOnce()
    expect(warn.records).toContainEqual(
      expect.objectContaining({ area: 'mail', level: 'warn', msg: 'verification_enqueue_failed', attempt: 1 }),
    )
    expect(JSON.stringify(warn.records)).not.toContain('MAIL_TOKEN_CANARY')
  } finally {
    enqueue.mockRestore()
    warn.restore()
  }
  expect(await countRows(database.db.selectFrom('accounts'))).toBe(1)
})

test.each([8, 128])('密码长度边界 %s 与 Better Auth 登录一致', async (length) => {
  const boundaryPassword = 'p'.repeat(length)
  await core.users.register(input({ password: boundaryPassword }))
  expect((await request('/sign-in/email', { email: 'steve@example.test', password: boundaryPassword })).status).toBe(
    200,
  )
})

test('找回密码入队收件人语言的邮件，令牌重设密码后旧会话失效，令牌不可重放', async () => {
  await configureMail()
  await core.users.register(input({ locale: 'zh-CN' }))
  await core.jobs.drain()
  expect(messages).toHaveLength(1)
  const login = await request('/sign-in/email', { email: 'steve@example.test', password })
  expect(login.status).toBe(200)
  const cookie = cookies(login)
  // Better Auth 的回调直接用 db 入队；哪次升级后回调进了它的事务，SQLite 上这里会以写锁超时失败（ADR-0021）
  expect(
    (await request('/request-password-reset', { email: 'steve@example.test', redirectTo: `${ROOT}/reset` })).status,
  ).toBe(200)
  await core.jobs.drain()
  expect(messages).toHaveLength(2)
  expect(messages[1]?.subject).toBe('重设你在 NextSkin 的密码')
  expect(messages[1]?.text).toContain('1 小时内有效')
  const token = mailUrl(messages[1]!).pathname.split('/').at(-1)!
  expect((await request('/reset-password', { token, newPassword: 'short' })).status).toBe(400)
  const newPassword = 'a brand new long password'
  expect((await request('/reset-password', { token, newPassword })).status).toBe(200)
  expect(await core.auth.getSessionUser(new Headers({ cookie }), ROOT)).toBeNull()
  expect((await request('/sign-in/email', { email: 'steve@example.test', password })).status).toBe(401)
  expect((await request('/sign-in/email', { email: 'steve@example.test', password: newPassword })).status).toBe(200)
  expect((await request('/reset-password', { token, newPassword })).status).toBe(400)
  // 修改设置后同一个缓存实例立即拒绝，已有和不存在的邮箱结果相同。
  await setting('mail.transport', 'none')
  for (const email of ['steve@example.test', 'nobody@example.test']) {
    const response = await request('/request-password-reset', { email })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'mail_not_configured' })
  }
})

test('未配置发件人时不入队，找回密码明确报错；Better Auth 自带注册关闭', async () => {
  await setting('mail.transport', 'smtp')
  await core.users.register(input({ locale: null }))
  await core.jobs.drain()
  expect(messages).toEqual([])
  expect(await countRows(database.db.selectFrom('jobs'))).toBe(0)
  const reset = await request('/request-password-reset', { email: 'nobody@example.test' })
  expect(reset.status).toBe(503)
  expect(await reset.json()).toMatchObject({ code: 'mail_not_configured' })
  const signup = await request('/sign-up/email', { email: 'other@example.test', password, name: 'Other' })
  expect(signup.status).toBe(400)
  expect(await signup.json()).toMatchObject({ code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' })
})

test('必须验证邮箱只影响显式检查，不阻止登录', async () => {
  await setting('auth.requireEmailVerification', true)
  await core.users.register(input())
  expect((await request('/sign-in/email', { email: 'steve@example.test', password })).status).toBe(200)
  expect(() => assertEmailVerified({ email_verified: 0 }, true)).toThrow(DomainError)
})

test('未完成安装时拒绝注册，先于设置读取，用户和凭据保持为空', async () => {
  await database.db.deleteFrom('import_runs').execute()
  const read = vi.spyOn(core.settings, 'read')
  try {
    await expect(core.users.register(input())).rejects.toMatchObject({ code: 'setup_required' })
    expect(read).not.toHaveBeenCalled()
    expect(await countRows(database.db.selectFrom('users'))).toBe(0)
    expect(await countRows(database.db.selectFrom('accounts'))).toBe(0)
  } finally {
    read.mockRestore()
  }
})
