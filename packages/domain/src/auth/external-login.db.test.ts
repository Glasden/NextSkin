import { createHash, randomBytes } from 'node:crypto'
import { countRows, insertReturningId, readAuthBoolean, toIsoTimestamp, upsert, writeAuthDate } from '@nextskin/db'
import { definePlugin, deny } from '@nextskin/plugin-sdk'
import { beforeEach, expect, test, vi } from 'vitest'
import { pauseNextCommit } from '../commit-pause.test-helper.ts'
import { buildPackage, hostEntry, pluginPackages } from '../plugins/host.test-helper.ts'
import { official, pluginEnvironment } from '../plugins/plugins.test-helper.ts'
import { encodeSettingValue } from '../settings/codec.ts'
import type { CoreSettingKey, CoreSettingValue } from '../settings/registry.ts'

const env = pluginEnvironment()
const siteUrl = 'https://skin.example.test'
const password = 'correct horse battery staple'
let identity = { subject: 'subject', email: 'external@example.test', emailVerified: true, displayName: 'External' }
let rejectRegistration = false
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
let actor: Awaited<ReturnType<typeof env.actor>>
/** 每个用户发起绑定用的会话（Better Auth 的 sessions 里的一行）；存 Promise，同一用户并发发起时共用一个 */
let sessions = new Map<number, Promise<number>>()

beforeEach(async () => {
  identity = { subject: 'subject', email: 'external@example.test', emailVerified: true, displayName: 'External' }
  rejectRegistration = false
  sessions = new Map()
  exchange.mockClear()
  await env.boot(
    [
      official('login', login()),
      official('other', login()),
      official(
        'gate',
        definePlugin({
          capabilities: [],
          intercept: {
            'user.register': () => Promise.resolve(rejectRegistration ? deny('test_denied', '测试拒绝') : undefined),
          },
        }),
      ),
    ],
    { plugins: { host: hostEntry, packages: (await pluginPackages()).packages } },
  )
  actor = await env.actor()
  for (const id of ['login', 'other', 'gate']) await env.core.plugins.admin.enable(actor, id)
})

async function insertSession(uid: number) {
  const at = new Date()
  return insertReturningId(env.db, 'sessions', {
    token: randomBytes(24).toString('base64url'),
    user_id: uid,
    expires_at: writeAuthDate(env.db, toIsoTimestamp(new Date(at.getTime() + 3600_000))),
    created_at: writeAuthDate(env.db, toIsoTimestamp(at)),
    updated_at: writeAuthDate(env.db, toIsoTimestamp(at)),
    ip_address: null,
    user_agent: null,
  })
}
function sessionOf(uid: number) {
  let id = sessions.get(uid)
  if (!id) sessions.set(uid, (id = insertSession(uid)))
  return id
}
async function start(uid: number | null = null, pluginId = 'login') {
  return env.core.externalLogin.start({
    pluginId,
    providerId: 'main',
    intent: uid === null ? 'signIn' : 'link',
    uid,
    sessionId: uid === null ? null : await sessionOf(uid),
    next: '/user/players',
    siteUrl,
  })
}
async function callback(
  state: string,
  sessionUid: number | null = null,
  pluginId = 'login',
  query: Record<string, string> = { state },
) {
  return env.core.externalLogin.callback({
    pluginId,
    providerId: 'main',
    query,
    cookieState: state,
    sessionUid,
    sessionId: sessionUid === null ? null : await sessionOf(sessionUid),
    siteUrl,
  })
}
async function pending() {
  const result = await callback((await start()).state)
  expect(result.kind).toBe('register')
  if (result.kind !== 'register') throw new Error('没有暂存身份')
  return result.pendingToken
}
function input(email = identity.email) {
  return { ...env.input({ email }), password: undefined }
}
async function user() {
  return env.core.users.register(env.input())
}
async function link(uid: number, pluginId = 'login') {
  expect(await callback((await start(uid, pluginId)).state, uid, pluginId)).toMatchObject({ kind: 'linked' })
}
async function passwordless() {
  return env.core.externalLogin.complete(await pending(), input())
}
const bindings = () => env.db.selectFrom('accounts').selectAll().where('provider_id', 'like', 'plugin:%').execute()
function codes(results: PromiseSettledResult<unknown>[]) {
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  return results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as { code: string }).code] : []))
}
async function setting<K extends CoreSettingKey>(key: K, value: CoreSettingValue<K>) {
  await upsert(env.db, 'settings', {
    values: {
      namespace: 'core',
      key,
      value: encodeSettingValue(key, value, { secretKey: env.secretKey }),
      updated_at: toIsoTimestamp(new Date()),
    },
    conflict: ['namespace', 'key'],
    update: ['value', 'updated_at'],
  })
}
function auth(path: string, body: unknown) {
  const request = new Request(siteUrl + '/api/auth' + path, {
    method: 'POST',
    headers: { origin: siteUrl, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // 和 Next 一样包装 Request，避免测试绕过服务端重建请求的分支。
  return env.core.auth.handle(
    new Proxy(request, { get: (target, key) => Reflect.get(target, key, target) as unknown }),
    siteUrl,
    '127.0.0.1',
  )
}

test('同一个第三方身份并发绑定两个用户，只有一个成功且只留一行', async () => {
  const users = await Promise.all([user(), user()])
  const states = await Promise.all(users.map(({ uid }) => start(uid)))
  const results = await Promise.allSettled(users.map(({ uid }, i) => callback(states[i]!.state, uid)))
  expect(codes(results)).toEqual(['identity_bound_elsewhere'])
  expect(await bindings()).toHaveLength(1)
})

test('同一用户并发绑定同一 Provider 的不同身份，只有一个成功且只留一行', async () => {
  const { uid } = await user()
  const states = await Promise.all([start(uid), start(uid)])
  // exchange 按调用次序返回独立快照，两个回调才会真的争抢不同的 subject。
  exchange.mockResolvedValueOnce({ ...identity, subject: 'one' }).mockResolvedValueOnce({ ...identity, subject: 'two' })
  const results = await Promise.allSettled(states.map(({ state }) => callback(state, uid)))
  expect(codes(results)).toEqual(['already_bound'])
  expect(await bindings()).toHaveLength(1)
})

test('注册拦截器拒绝时整体回滚，暂存身份可重试；成功后不能重放', async () => {
  const token = await pending()
  const registration = input()
  const before = await countRows(env.db.selectFrom('users'))
  rejectRegistration = true
  await expect(env.core.externalLogin.complete(token, registration)).rejects.toMatchObject({
    code: 'registration_denied',
  })
  expect(await countRows(env.db.selectFrom('users'))).toBe(before)
  expect(await bindings()).toEqual([])
  expect(await env.core.externalLogin.pending(token)).not.toBeNull()
  rejectRegistration = false
  await expect(env.core.externalLogin.complete(token, registration)).resolves.toMatchObject({ next: '/user/players' })
  expect(await bindings()).toHaveLength(1)
  expect(await countRows(env.db.selectFrom('users'))).toBe(before + 1)
  await expect(env.core.externalLogin.complete(token, registration)).rejects.toMatchObject({
    code: 'external_login_expired',
  })
})

test.each([false, true])(
  '同一暂存身份并发完成注册（表单邮箱不同：%s），只创建一个用户和一个绑定',
  async (differentEmail) => {
    const token = await pending()
    const before = await countRows(env.db.selectFrom('users'))
    const first = input('first@example.test')
    // 同时覆盖双击同一份表单，和两个标签页改成不同邮箱后提交；两种情况都只能消费身份一次。
    const second = differentEmail ? input('second@example.test') : first
    const results = await Promise.allSettled(
      [first, second].map((registration) => env.core.externalLogin.complete(token, registration)),
    )
    // 暂存身份在注册事务里认领：后到的那个在事务开头就停下，不会走到邮箱或绑定的唯一约束
    expect(codes(results)).toEqual(['external_login_expired'])
    expect(await countRows(env.db.selectFrom('users'))).toBe(before + 1)
    expect(await bindings()).toHaveLength(1)
  },
)

test.each([false, true])('首次注册邮箱是否改动：%s，只有保持第三方已验证邮箱才免验证邮件', async (changed) => {
  await setting('mail.transport', 'smtp')
  await setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
  const send = vi.spyOn(env.core.auth, 'sendVerificationEmail').mockResolvedValue(undefined)
  try {
    const { uid } = await env.core.externalLogin.complete(
      await pending(),
      input(changed ? 'changed@example.test' : identity.email),
    )
    const row = await env.db
      .selectFrom('users')
      .select('email_verified')
      .where('id', '=', uid)
      .executeTakeFirstOrThrow()
    expect(readAuthBoolean(row.email_verified)).toBe(!changed)
    expect(send).toHaveBeenCalledTimes(changed ? 1 : 0)
  } finally {
    send.mockRestore()
  }
})

test.each(['password', 'verified', 'unverified'] as const)('邮箱撞上已有账号：%s', async (mode) => {
  const registration = env.input({ email: identity.email })
  const { uid } = await env.core.users.register(registration)
  if (mode !== 'password') await env.db.deleteFrom('accounts').where('user_id', '=', uid).execute()
  identity.emailVerified = mode !== 'unverified'
  const result = callback((await start()).state)
  if (mode === 'verified') {
    await expect(result).resolves.toMatchObject({ kind: 'signedIn', uid })
    expect(await bindings()).toHaveLength(1)
  } else {
    await expect(result).rejects.toMatchObject({ code: 'external_email_taken' })
    expect(await bindings()).toEqual([])
  }
})

test('两家第三方同时声明同一个没有登录方式的账号：锁住用户之后再确认一遍，只有一家能绑上', async () => {
  const { uid } = await env.core.users.register(env.input({ email: identity.email }))
  await env.db.deleteFrom('accounts').where('user_id', '=', uid).execute()
  const [a, b] = await Promise.all([start(null, 'login'), start(null, 'other')])
  const results = await Promise.allSettled([callback(a.state, null, 'login'), callback(b.state, null, 'other')])
  expect(codes(results)).toEqual(['external_email_taken'])
  expect(await bindings()).toHaveLength(1)
})

test('不能解绑最后一种登录方式；停用插件的绑定不算可用方式', async () => {
  const { uid } = await passwordless()
  await link(uid, 'other')
  await env.core.plugins.admin.disable(actor, 'other')
  await expect(env.core.externalLogin.unlink(uid, 'login', 'main')).rejects.toMatchObject({ code: 'last_login_method' })
  expect(await bindings()).toHaveLength(2)
  await env.core.plugins.admin.enable(actor, 'other')
  await env.core.externalLogin.unlink(uid, 'login', 'main')
  expect((await bindings()).map((row) => row.provider_id)).toEqual(['plugin:other:main'])
  await expect(env.core.externalLogin.unlink(uid, 'other', 'main')).rejects.toMatchObject({ code: 'last_login_method' })
})

test.each(['password', 'passkey'] as const)('有另一种登录方式 %s 时允许解绑', async (method) => {
  const { uid } = method === 'password' ? await user() : await passwordless()
  if (method === 'password') await link(uid)
  else
    await env.db
      .insertInto('passkeys')
      .values({
        user_id: uid,
        name: 'Test',
        public_key: 'public',
        credential_id: 'credential',
        counter: 0,
        device_type: 'singleDevice',
        backed_up: false,
        transports: null,
        aaguid: null,
        created_at: writeAuthDate(env.db, toIsoTimestamp(new Date())),
      })
      .execute()
  await env.core.externalLogin.unlink(uid, 'login', 'main')
  expect(await bindings()).toEqual([])
})

test('安装插件的绑定统计和卸载：只删除该插件的绑定，准确统计会失去登录方式的用户', async () => {
  const source = `import { definePlugin } from '@nextskin/plugin-sdk'
export default definePlugin({ capabilities: [], providers: { login: [{ id: 'main', label: 'login.main', icon: 'github',
  authorizeUrl: () => Promise.resolve('https://identity.example.test/authorize'),
  exchange: async ({ query }) => ({ subject: query.subject, email: null, emailVerified: false, displayName: null }) }] } })`
  const admin = await env.actor()
  const bytes = await buildPackage({ id: 'installed-login', source })
  const preview = await env.core.plugins.admin.preview(admin, bytes)
  await env.core.plugins.admin.install(admin, bytes, preview.packageHash)
  for (const id of ['installed-login', 'other']) await env.core.plugins.admin.enable(admin, id)
  const users = await Promise.all([user(), user(), user(), user()])
  for (const [index, { uid }] of users.entries()) {
    const state = (await start(uid, 'installed-login')).state
    await callback(state, uid, 'installed-login', { state, subject: String(index) })
    if (index !== 0)
      await env.db.deleteFrom('accounts').where('user_id', '=', uid).where('provider_id', '=', 'credential').execute()
  }
  await link(users[2].uid, 'other')
  await env.db
    .insertInto('passkeys')
    .values({
      user_id: users[3].uid,
      name: 'Test',
      public_key: 'public',
      credential_id: 'credential',
      counter: 0,
      device_type: 'singleDevice',
      backed_up: false,
      transports: null,
      aaguid: null,
      created_at: writeAuthDate(env.db, toIsoTimestamp(new Date())),
    })
    .execute()
  expect(await env.core.plugins.admin.detail(admin, 'installed-login')).toMatchObject({
    logins: [{ providerId: 'main', bindings: 4 }],
    strandedOnUninstall: 1,
  })
  await env.core.plugins.admin.disable(admin, 'other')
  expect((await env.core.plugins.admin.detail(admin, 'installed-login')).strandedOnUninstall).toBe(2)
  // 卸载时还没用完的 state 和暂存身份：之后装上来的同 id 插件可能对接另一个第三方，旧的 subject 不能落到它名下
  const signIn = (await start(null, 'installed-login')).state
  const leftover = await callback(signIn, null, 'installed-login', { state: signIn, subject: 'new' })
  if (leftover.kind !== 'register') throw new Error('没有暂存身份')
  await start(null, 'installed-login')
  const kept = await pending()
  await env.core.plugins.admin.uninstall(admin, 'installed-login')
  expect((await bindings()).map((row) => row.provider_id)).toEqual(['plugin:other:main'])
  expect(await env.core.externalLogin.pending(leftover.pendingToken)).toBeNull()
  expect(await countRows(env.db.selectFrom('verifications').where('value', 'like', '%installed-login%'))).toBe(0)
  expect(await env.core.externalLogin.pending(kept)).toMatchObject({ pluginId: 'login' })
}, 60_000)

test('无密码账号通过找回密码设置密码后可以用邮箱密码登录', async () => {
  const { uid } = await passwordless()
  expect(await env.core.externalLogin.hasPassword(uid)).toBe(false)
  await setting('mail.transport', 'smtp')
  await setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
  expect(
    (await auth('/request-password-reset', { email: identity.email, redirectTo: siteUrl + '/reset-password' })).status,
  ).toBe(200)
  const row = await env.db
    .selectFrom('verifications')
    .select('identifier')
    .where('identifier', 'like', 'reset-password:%')
    .executeTakeFirstOrThrow()
  const token = row.identifier.slice('reset-password:'.length)
  expect((await auth('/reset-password', { token, newPassword: password })).status).toBe(200)
  expect((await auth('/sign-in/email', { email: identity.email, password })).status).toBe(200)
})

test('state 必须和 Cookie 一致、未过期且只能用一次；取消授权不调用 exchange', async () => {
  const state = (await start()).state
  await expect(
    env.core.externalLogin.callback({
      pluginId: 'login',
      providerId: 'main',
      query: { state },
      cookieState: 'wrong',
      sessionUid: null,
      sessionId: null,
      siteUrl,
    }),
  ).rejects.toMatchObject({ code: 'external_login_expired', params: undefined })
  expect(exchange).not.toHaveBeenCalled()
  await callback(state)
  await expect(callback(state)).rejects.toMatchObject({ code: 'external_login_expired' })
  const expired = (await start()).state
  await env.db
    .updateTable('verifications')
    .set({ expires_at: writeAuthDate(env.db, toIsoTimestamp(new Date(0))) })
    .where('identifier', '=', 'external-login:state:' + createHash('sha256').update(expired).digest('base64url'))
    .execute()
  await expect(callback(expired)).rejects.toMatchObject({ code: 'external_login_expired' })
  exchange.mockClear()
  const cancelled = (await start()).state
  await expect(callback(cancelled, null, 'login', { state: cancelled, error: 'access_denied' })).rejects.toMatchObject({
    code: 'external_login_cancelled',
    params: { intent: 'signIn', next: '/user/players' },
  })
  expect(exchange).not.toHaveBeenCalled()
})

// GitHub 会先校验数字 id；这里绕过它，直接守住核心对不受信插件返回值的检查。
test.each(['invalid subject', '', 's'.repeat(256)])('核心拒绝插件返回的非法 subject：%j', async (subject) => {
  identity.subject = subject
  await expect(callback((await start()).state)).rejects.toMatchObject({
    code: 'external_login_failed',
    params: { intent: 'signIn', next: '/user/players' },
  })
  expect(await bindings()).toEqual([])
  expect(env.lines.join('\n')).toContain('login_failed')
  expect(env.lines.join('\n')).not.toContain(identity.email)
})

test('绑定认发起它的那个会话：换了会话、会话被删、旧 state 没有记下会话，都按过期处理', async () => {
  const { uid } = await user()
  const other = await insertSession(uid)
  const changed = (await start(uid)).state
  await expect(
    env.core.externalLogin.callback({
      pluginId: 'login',
      providerId: 'main',
      query: { state: changed },
      cookieState: changed,
      sessionUid: uid,
      sessionId: other,
      siteUrl,
    }),
  ).rejects.toMatchObject({ code: 'external_login_expired' })
  // 加 sessionId 之前签发的 state
  const legacy = (await start(uid)).state
  const key = 'external-login:state:' + createHash('sha256').update(legacy).digest('base64url')
  const row = await env.db
    .selectFrom('verifications')
    .select('value')
    .where('identifier', '=', key)
    .executeTakeFirstOrThrow()
  const value = JSON.parse(row.value) as Record<string, unknown>
  delete value.sessionId
  await env.db
    .updateTable('verifications')
    .set({ value: JSON.stringify(value) })
    .where('identifier', '=', key)
    .execute()
  await expect(callback(legacy, uid)).rejects.toMatchObject({ code: 'external_login_expired' })
  // 回调开头核对的会话 id 对得上，但这一行在写绑定之前已经没了
  const revoked = (await start(uid)).state
  await env.db.deleteFrom('sessions').where('user_id', '=', uid).execute()
  await expect(callback(revoked, uid)).rejects.toMatchObject({ code: 'external_login_expired' })
  expect(await bindings()).toEqual([])
})

test('回调正在向第三方换令牌时后台退出全部登录：写绑定时在锁内发现会话没了，最终没有新绑定', async () => {
  const { uid } = await user()
  const { state } = await start(uid)
  const arrived = Promise.withResolvers<void>()
  const exchanged = Promise.withResolvers<typeof identity>()
  exchange.mockImplementationOnce(() => {
    arrived.resolve()
    return exchanged.promise
  })
  const pending = callback(state, uid)
  await arrived.promise
  // 退出全部登录的事务删完会话、停在提交之前，这时换令牌回来：写绑定的事务排在用户行锁上（SQLite 上排在唯一的连接上），
  // 锁内才看得到会话没了。在锁外查会话的话，READ COMMITTED 下读到的还是删除之前的那一行
  const pause = pauseNextCommit(env.db)
  try {
    const revoking = env.core.admin.revokeUserSessions(actor, uid)
    await Promise.race([pause.entered, revoking])
    exchanged.resolve({ ...identity })
    await pause.contended
    // 给写绑定的事务一点时间走到用户行锁上
    await new Promise((resolve) => setTimeout(resolve, 100))
    pause.resume()
    expect((await revoking).revokedSessions).toBeGreaterThan(0)
  } finally {
    pause.restore()
  }
  await expect(pending).rejects.toMatchObject({ code: 'external_login_expired' })
  expect(await bindings()).toEqual([])
  expect(await countRows(env.db.selectFrom('sessions').where('user_id', '=', uid))).toBe(0)
})
