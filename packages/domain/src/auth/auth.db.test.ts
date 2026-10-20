import { markSiteInitialized } from '../setup/initialized.test-helper.ts'
import { createHash, randomBytes } from 'node:crypto'
import {
  coreMigrations,
  migrateToLatest,
  transactionWithRetry,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { runWithRequestState } from '@better-auth/core/context'
import { oauthProvider } from '@better-auth/oauth-provider'
import { hashPassword, makeSignature, verifyPassword } from 'better-auth/crypto'
import { bcrypt } from 'hash-wasm'
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createCore, encodeSettingValue, type Core, type CoreSettingKey, type CoreSettingValue } from '../index.ts'
import { revokeLogins } from './revoke.ts'
import { createAuth, sha256 } from './auth.ts'
import { JOIN_SCOPE, READ_SCOPE, SELECT_SCOPE } from '../oauth/scopes.ts'
import { createAuthService } from './service.ts'
import { consentReferenceId, yggdrasilConnect } from './connect.ts'
import { isLegacyPasswordHash } from './legacy-passwords.ts'
import { checkUserPassword } from './password.ts'

// 请求级测试：经过 core.auth.handle，与 Hono 挂载的路径相同。Next 里 request.url 的 host 是它自己的监听地址，
// 客户端看到的站点地址另外传入，这里故意让两者不同。

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const ROOT = 'http://localhost:3000'
const LISTEN = 'http://127.0.0.1:3000'
const CALLBACK = 'https://app.example.test/callback'

let database: TestDatabase<CoreDatabase>
let core: Core

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
  await markSiteInitialized(database.db)
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
  })
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  // 外键会级联删掉会话、账号、客户端和令牌
  await database.db.deleteFrom('oauth_clients').where('client_id', '!=', 'shared').execute()
  await database.db.updateTable('oauth_clients').set({ disabled: false }).where('client_id', '=', 'shared').execute()
  await database.db.deleteFrom('users').execute()
  await database.db.deleteFrom('settings').execute()
})

async function storeSetting<K extends CoreSettingKey>(key: K, value: CoreSettingValue<K>) {
  await database.db
    .insertInto('settings')
    .values({
      namespace: 'core',
      key,
      value: encodeSettingValue(key, value, { secretKey }),
      updated_at: toIsoTimestamp(new Date()),
    })
    .execute()
}

interface RequestOptions {
  method?: string
  json?: unknown
  form?: Record<string, string>
  headers?: Record<string, string>
}

/** 带 Cookie 的浏览器；每个实例一个独立的会话 */
class Browser {
  readonly jar = new Map<string, string>()
  readonly target: Core
  readonly root: string
  constructor(target: Core = core, root = ROOT) {
    this.target = target
    this.root = root
  }

  cookieHeader() {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  async request(path: string, options: RequestOptions = {}) {
    const headers = new Headers({ origin: this.root, ...options.headers })
    if (this.jar.size) headers.set('cookie', this.cookieHeader())
    let body: string | undefined
    if (options.json !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(options.json)
    } else if (options.form) {
      headers.set('content-type', 'application/x-www-form-urlencoded')
      body = new URLSearchParams(options.form).toString()
    }
    const method = options.method ?? (body === undefined ? 'GET' : 'POST')
    // Next 用 Proxy 包装 Request；Node 的 new Request(proxy) 会抛 TypeError。
    const request = new Proxy(new Request(new URL(path, LISTEN), { method, headers, body }), {
      get: (target, property) => Reflect.get(target, property, target) as unknown,
    })
    const response = await this.target.auth.handle(request, this.root, '127.0.0.1')
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!
      const index = pair.indexOf('=')
      const [name, value] = [pair.slice(0, index), pair.slice(index + 1)]
      if (!value || /max-age=0/i.test(cookie)) this.jar.delete(name)
      else this.jar.set(name, value)
    }
    return response
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

/** Better Auth 对 fetch 请求有时返回 302，有时返回 { redirect, url }，统一取跳转目标 */
async function redirectTarget(response: Response): Promise<URL> {
  const location = response.headers.get('location')
  if (location) return new URL(location, ROOT)
  const body = await json(response)
  if (typeof body.url !== 'string')
    throw new Error(`expected a redirect, got ${response.status} (${String(body.error)})`)
  return new URL(body.url, ROOT)
}

const password = 'correct horse battery staple'

async function signUp(email: string, name = 'Steve') {
  const browser = new Browser()
  const { uid } = await core.users.register({ email, password, playerName: name, ip: '127.0.0.1', locale: null })
  const response = await browser.request('/api/auth/sign-in/email', { json: { email, password } })
  expect(response.status).toBe(200)
  return { browser, uid }
}

async function signUpAdmin() {
  const admin = await signUp('admin@example.test', 'Admin')
  await database.db.updateTable('users').set({ role: 'admin' }).where('id', '=', admin.uid).execute()
  return admin.browser
}

interface CreatedClient {
  client_id: string
  client_secret: string
}

async function createClient(
  admin: Browser,
  body: { token_endpoint_auth_method?: string; grant_types?: string[]; scope?: string },
): Promise<CreatedClient> {
  const client = { client_id: randomBytes(12).toString('hex'), client_secret: randomBytes(24).toString('hex') }
  const user = await core.auth.getSessionUser(new Headers({ cookie: admin.cookieHeader() }), ROOT)
  const now = writeAuthDate(database.db, toIsoTimestamp(new Date()))
  await database.db
    .insertInto('oauth_clients')
    .values({
      ...client,
      client_secret: sha256(client.client_secret),
      name: 'Example App',
      user_id: user!.uid,
      redirect_uris: JSON.stringify([CALLBACK]),
      token_endpoint_auth_method: body.token_endpoint_auth_method ?? 'client_secret_post',
      grant_types: JSON.stringify(body.grant_types ?? ['authorization_code', 'refresh_token']),
      scopes: body.scope ? JSON.stringify(body.scope.split(' ')) : null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  return client
}

function basic(clientId: string, secret: string) {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`
}

test('注册和登录：整数 uid、邮箱转小写、会话 Cookie 是 HttpOnly + SameSite=Lax', async () => {
  const { uid } = await signUp('Steve@Example.TEST', 'Steve')
  expect(Number.isSafeInteger(uid)).toBe(true)
  const row = await database.db.selectFrom('users').selectAll().where('id', '=', uid).executeTakeFirstOrThrow()
  expect(row).toMatchObject({ email: 'steve@example.test', nickname: 'Steve', role: 'user', score: 1000 })

  const signIn = await new Browser().request('/api/auth/sign-in/email', {
    json: { email: 'steve@example.test', password },
  })
  expect(signIn.status).toBe(200)
  const cookie = signIn.headers.getSetCookie().find((value) => value.startsWith('nextskin.session_token='))
  expect(cookie).toMatch(/; HttpOnly/)
  expect(cookie).toMatch(/; SameSite=Lax/)

  const wrong = await new Browser().request('/api/auth/sign-in/email', {
    json: { email: 'steve@example.test', password: 'not the password' },
  })
  expect(wrong.status).toBe(401)
})

test('getSessionUser 返回 uid、昵称、身份、语言和会话行的 id；没有会话时返回 null', async () => {
  const { browser, uid } = await signUp('alex@example.test', 'Alex')
  expect(await core.auth.getSessionUser(new Headers({ cookie: browser.cookieHeader() }), ROOT)).toEqual({
    uid,
    nickname: 'Alex',
    email: 'alex@example.test',
    role: 'user',
    locale: null,
    sessionId: expect.any(Number) as unknown,
  })
  expect(await core.auth.getSessionUser(new Headers(), ROOT)).toBeNull()
})

// 由 PHP 8.1（BS v6 的运行环境）生成，与 legacy-passwords.test.ts 的向量相同
const legacyPassword = 'php-era-password'
const legacySalt = 'bs-salt-中文'
const legacyHashes = {
  bcrypt: '$2y$10$rGpvsoGqqJj9Ahl6AnxY2uSd8VfK46pZU.MJKrw8/SYZwHn29jTB.',
  argon2i: '$argon2i$v=19$m=1024,t=2,p=1$dWp5eG9hSUdjOExxUlFFTQ$0+g6q+9g7eVJr+wgfOp/SCAOc0xZ58vxqL9Nqxb0NYA',
  salted2sha256: '$bs$salted2sha256$a99c25c7b8f53925aedf19fe78ccd0838ecb44f54baa455289c36798a80b07eb',
}

test.each(Object.entries(legacyHashes))('从 BS 导入的 %s 密码可以登录，登录后换成当前算法', async (_, hash) => {
  await storeSetting('auth.legacyPasswordSalt', legacySalt)
  const { uid } = await signUp('legacy@example.test', 'Legacy')
  const account = () =>
    database.db
      .selectFrom('accounts')
      .select('password')
      .where('user_id', '=', uid)
      .where('provider_id', '=', 'credential')
      .executeTakeFirstOrThrow()
  await database.db.updateTable('accounts').set({ password: hash }).where('user_id', '=', uid).execute()

  const signIn = (value: string) =>
    new Browser().request('/api/auth/sign-in/email', { json: { email: 'legacy@example.test', password: value } })
  expect((await signIn('wrong password')).status).toBe(401)
  expect((await account()).password).toBe(hash)

  expect((await signIn(legacyPassword)).status).toBe(200)
  const rehashed = (await account()).password!
  expect(rehashed).not.toBe(hash)
  expect(isLegacyPasswordHash(rehashed)).toBe(false)
  expect((await signIn(legacyPassword)).status).toBe(200)
  expect((await signIn('wrong password')).status).toBe(401)
})

test.each(['bcrypt', 'sha256'])('旧 %s 密码支持 PHP trim 回退，升级只使用核对通过的值', async (algorithm) => {
  const { uid } = await signUp('trim@example.test', 'Trim')
  const hash =
    algorithm === 'bcrypt'
      ? await bcrypt({ password: 'secret', salt: '0123456789abcdef', costFactor: 4, outputType: 'encoded' })
      : `$bs$sha256$${createHash('sha256').update('secret').digest('hex')}`
  await database.db.updateTable('accounts').set({ password: hash }).where('user_id', '=', uid).execute()
  const signIn = (value: string) =>
    new Browser().request('/api/auth/sign-in/email', { json: { email: 'trim@example.test', password: value } })
  const salt = { legacySalt: () => Promise.resolve('') }
  expect(await checkUserPassword(database.db, uid, ' secret\t', salt)).toBe(hash)
  expect(await checkUserPassword(database.db, uid, 'wrong', salt)).toBeNull()
  expect((await signIn('secret\u00a0')).status).toBe(401)
  expect((await signIn(' secret\t')).status).toBe(200)
  const account = await database.db
    .selectFrom('accounts')
    .select('password')
    .where('user_id', '=', uid)
    .where('provider_id', '=', 'credential')
    .executeTakeFirstOrThrow()
  expect(isLegacyPasswordHash(account.password!)).toBe(false)
  expect(await verifyPassword({ hash: account.password!, password: 'secret' })).toBe(true)
  expect(await verifyPassword({ hash: account.password!, password: ' secret\t' })).toBe(false)
  expect((await signIn('secret')).status).toBe(200)
  expect((await signIn(' secret\t')).status).toBe(401)
  expect(await checkUserPassword(database.db, uid, ' secret\t', salt)).toBeNull()
})

test.each([
  ['无首尾空格', 'secret'],
  ['有首尾空格', ' secret '],
])('当前算法的密码保留首尾空格（%s）', async (_, value) => {
  const { uid } = await signUp('current@example.test', 'Current')
  const hash = await hashPassword(value)
  await database.db.updateTable('accounts').set({ password: hash }).where('user_id', '=', uid).execute()
  const signIn = (password: string) =>
    new Browser().request('/api/auth/sign-in/email', { json: { email: 'current@example.test', password } })
  expect((await signIn(value)).status).toBe(200)
  expect((await signIn(value === 'secret' ? ' secret ' : 'secret')).status).toBe(401)
  const account = await database.db
    .selectFrom('accounts')
    .select('password')
    .where('user_id', '=', uid)
    .where('provider_id', '=', 'credential')
    .executeTakeFirstOrThrow()
  expect(account.password).toBe(hash)
})

test('Better Auth 客户端管理端点关闭，写操作由领域用例处理', async () => {
  const { browser } = await signUp('user@example.test')
  const response = await browser.request('/api/auth/oauth2/create-client', {
    json: { client_name: 'Example App', redirect_uris: [CALLBACK] },
  })
  expect(response.status).toBe(404)
  expect(
    await database.db.selectFrom('oauth_clients').select('id').where('client_id', '!=', 'shared').execute(),
  ).toEqual([])
})

// Better Auth 会先 trim 再校验认证方式，前后带空白的值同样会被存成 private_key_jwt（独立审核发现）
test.each(['private_key_jwt', ' private_key_jwt ', 'private_key_jwt\n', 'PRIVATE_KEY_JWT', 'tls_client_auth'])(
  '创建和修改客户端端点均已关闭（%j）',
  async (method) => {
    const admin = await signUpAdmin()
    const create = await admin.request('/api/auth/oauth2/create-client', {
      json: {
        client_name: 'JWT App',
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: method,
        jwks_uri: 'https://app.example.test/jwks',
      },
    })
    expect(create.status).toBe(404)

    const client = await createClient(admin, { token_endpoint_auth_method: 'client_secret_post' })
    const update = await admin.request('/api/auth/oauth2/update-client', {
      json: { client_id: client.client_id, update: { token_endpoint_auth_method: method } },
    })
    expect(update.status).toBe(404)
    const rows = await database.db
      .selectFrom('oauth_clients')
      .select('token_endpoint_auth_method')
      .where('client_id', '=', client.client_id)
      .execute()
    expect(rows).toEqual([{ token_endpoint_auth_method: 'client_secret_post' }])
  },
)

test.each(['token', 'introspect', 'revoke'])('%s 端点拒绝 client_assertion', async (endpoint) => {
  const response = await new Browser().request(`/api/auth/oauth2/${endpoint}`, {
    form: {
      grant_type: 'client_credentials',
      token: 'unused',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'e30.e30.signature',
    },
  })
  expect(response.status).toBe(400)
  expect(await json(response)).toMatchObject({ error: 'invalid_client' })
})

test.each(['client_secret_post', 'client_secret_basic'])(
  '登记为 %s 的保密客户端用 Basic 和请求体传密钥都能认证，密钥错误时都失败',
  async (method) => {
    const admin = await signUpAdmin()
    const client = await createClient(admin, { token_endpoint_auth_method: method })
    const introspect = (form: Record<string, string>, headers: Record<string, string> = {}) =>
      new Browser().request('/api/auth/oauth2/introspect', { form: { token: 'not-a-token', ...form }, headers })

    for (const response of [
      await introspect({ client_id: client.client_id, client_secret: client.client_secret }),
      await introspect({}, { authorization: basic(client.client_id, client.client_secret) }),
    ]) {
      expect(response.status).toBe(200)
      expect(await json(response)).toEqual({ active: false })
    }
    for (const response of [
      await introspect({ client_id: client.client_id, client_secret: 'wrong' }),
      await introspect({}, { authorization: basic(client.client_id, 'wrong') }),
    ]) {
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(await json(response)).toMatchObject({ error: 'invalid_client' })
    }
  },
)

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

function authorizationQuery(client: CreatedClient, scope?: string, prompt?: string) {
  const proof = pkce()
  const state = randomBytes(8).toString('hex')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    ...(scope === undefined ? {} : { scope }),
    ...(prompt === undefined ? {} : { prompt }),
    state,
    code_challenge: proof.challenge,
    code_challenge_method: 'S256',
  })
  return { proof, state, query }
}

/** 授权码流走到拿到授权码为止：authorize → 同意页 → 回调 */
async function authorize(browser: Browser, client: CreatedClient, scope?: string, pid?: number) {
  const { proof, state, query } = authorizationQuery(client, scope)
  const consentPage = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
  expect(consentPage.pathname).toBe('/oauth/consent')
  const callback = await redirectTarget(
    await browser.request('/api/auth/oauth2/consent', {
      json: { accept: true, oauth_query: consentPage.search.slice(1) },
      ...(pid === undefined ? {} : { headers: { 'X-NextSkin-Player': String(pid) } }),
    }),
  )
  expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
  expect(callback.searchParams.get('state')).toBe(state)
  return {
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code')!,
    redirect_uri: CALLBACK,
    client_id: client.client_id,
    client_secret: client.client_secret,
    code_verifier: proof.verifier,
  }
}

const CONNECT_SCOPE = `openid offline_access ${SELECT_SCOPE} ${JOIN_SCOPE}`

async function playerOf(uid: number) {
  return database.db.selectFrom('players').selectAll().where('user_id', '=', uid).executeTakeFirstOrThrow()
}

async function consentPage(browser: Browser, client: CreatedClient, scope = CONNECT_SCOPE) {
  const { query } = authorizationQuery(client, scope)
  const page = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
  expect(page.pathname).toBe('/oauth/consent')
  return page
}

// 只在测试中签构造的过期或异常参数，密钥仍取自实例；生产代码只认 Better Auth 发来的签名。
async function signedQuery(params: URLSearchParams) {
  const auth = createAuth({
    db: database.db,
    secretKey,
    siteUrl: ROOT,
    siteName: 'NextSkin',
    legacyPasswordSalt: () => Promise.resolve(''),
  })
  params = new URLSearchParams(params)
  params.delete('sig')
  params.delete('ba_param')
  const names = [...new Set([...params.keys(), 'ba_param'])].sort()
  for (const name of names) params.append('ba_param', name)
  const sorted = [...params].sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0))
  params.set('sig', await makeSignature(new URLSearchParams(sorted).toString(), (await auth.$context).secret))
  return params.toString()
}

test('机密客户端从登录到 Select + Join 的授权码、刷新令牌和声明都绑定同一个角色', async () => {
  const owner = await signUp('client-owner@example.test', 'Owner')
  const client = await createClient(owner.browser, {})
  const { uid } = await core.users.register({
    email: 'connect-code@example.test',
    password,
    playerName: 'ConnectCode',
    ip: '127.0.0.1',
    locale: null,
  })
  const player = await playerOf(uid)
  const browser = new Browser()
  const { query, proof, state } = authorizationQuery(client, CONNECT_SCOPE)
  const login = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
  expect(login.pathname).toBe('/sign-in')
  const continuation = await core.auth.authorizationContinuation(login.search, new Headers(), ROOT)
  expect(continuation?.resume).toBe(false)
  expect(
    (await browser.request('/api/auth/sign-in/email', { json: { email: 'connect-code@example.test', password } }))
      .status,
  ).toBe(200)
  const page = await redirectTarget(await browser.request(continuation!.next))
  expect(page.pathname).toBe('/oauth/consent')
  const consent = await browser.request('/api/auth/oauth2/consent', {
    json: { accept: true, oauth_query: page.search.slice(1) },
    headers: { 'X-NextSkin-Player': String(player.id), 'sec-fetch-mode': 'cors' },
  })
  expect(consent.status).toBe(200)
  const result = await json(consent)
  expect(result.redirect).toBe(true)
  const callback = new URL(result.url as string)
  expect(callback.searchParams.get('state')).toBe(state)
  expect(callback.searchParams.get('iss')).toBe(`${ROOT}/api/auth`)
  const code = callback.searchParams.get('code')!
  expect(!!code).toBe(true)
  const storedCode = await database.db
    .selectFrom('verifications')
    .select('value')
    .where('identifier', '=', sha256(code))
    .executeTakeFirstOrThrow()
  expect((JSON.parse(storedCode.value) as { referenceId: string }).referenceId).toBe(`player:${player.id}`)
  const response = await browser.request('/api/auth/oauth2/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: CALLBACK,
      code,
      code_verifier: proof.verifier,
    },
  })
  expect(response.status).toBe(200)
  const tokens = await json(response)
  const profile = { id: player.uuid.replaceAll('-', ''), name: player.name }
  expect(decodeJwt(tokens.id_token as string).selectedProfile).toEqual(profile)
  const info = await browser.request('/api/auth/oauth2/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token as string}` },
  })
  expect(info.status).toBe(200)
  expect((await json(info)).selectedProfile).toEqual(profile)
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_consents'] as const) {
    const rows = await database.db
      .selectFrom(table)
      .select('reference_id')
      .where('client_id', '=', client.client_id)
      .execute()
    expect(rows).toEqual([{ reference_id: `player:${player.id}` }])
  }
  // 完整流程也证明 oauth-provider 的 before 已在 Connect 之前验签并写好请求状态。
  const invalid = await browser.request('/api/auth/oauth2/consent', {
    json: { accept: true, oauth_query: `${page.search.slice(1)}&scope=openid` },
    headers: { 'X-NextSkin-Player': String(player.id) },
  })
  expect(invalid.status).toBe(400)
  expect((await json(invalid)).error).toBe('invalid_signature')
})

test('Read 的授权码流程不绑定角色，ID 令牌和 userinfo 给出全部角色', async () => {
  const { browser, uid } = await signUp('read-code@example.test')
  const client = await createClient(browser, {})
  const response = await browser.request('/api/auth/oauth2/token', {
    form: await authorize(browser, client, `openid ${READ_SCOPE}`),
  })
  expect(response.status).toBe(200)
  const tokens = await json(response)
  const player = await playerOf(uid)
  const profiles = [{ id: player.uuid.replaceAll('-', ''), name: player.name }]
  const claims = decodeJwt(tokens.id_token as string)
  expect(claims.availableProfiles).toEqual(profiles)
  expect(claims).not.toHaveProperty('selectedProfile')
  const info = await browser.request('/api/auth/oauth2/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token as string}` },
  })
  expect((await json(info)).availableProfiles).toEqual(profiles)
  expect(await database.db.selectFrom('oauth_consents').select('reference_id').execute()).toEqual([
    { reference_id: null },
  ])
})

test('Select 每次强制同意，换角色新建同意记录，同角色再次同意更新原记录', async () => {
  const { browser, uid } = await signUp('select-code@example.test')
  const client = await createClient(browser, {})
  const first = await playerOf(uid)
  await core.players.create({ uid }, { name: 'Second' })
  const second = await database.db
    .selectFrom('players')
    .select('id')
    .where('user_id', '=', uid)
    .where('id', '!=', first.id)
    .executeTakeFirstOrThrow()
  await authorize(browser, client, CONNECT_SCOPE, first.id)
  await consentPage(browser, client)
  await authorize(browser, client, CONNECT_SCOPE, second.id)
  await authorize(browser, client, CONNECT_SCOPE, first.id)
  const consents = await database.db.selectFrom('oauth_consents').select('reference_id').orderBy('id').execute()
  expect(consents).toEqual([{ reference_id: `player:${first.id}` }, { reference_id: `player:${second.id}` }])
  const { query } = authorizationQuery(client, CONNECT_SCOPE, 'none')
  for (const [target, error] of [
    [browser, 'consent_required'],
    [new Browser(), 'login_required'],
  ] as const) {
    const callback = await redirectTarget(await target.request(`/api/auth/oauth2/authorize?${query.toString()}`))
    expect(callback.searchParams.get('error')).toBe(error)
  }
})

test.each([undefined, '0', '01', '1e3', '1 1', '9007199254740991', '9007199254740992', 'other'])(
  'Select 同意拒绝缺失或不属于用户的严格整数 pid：%s',
  async (header) => {
    const { browser } = await signUp('selection@example.test')
    const client = await createClient(browser, {})
    const page = await consentPage(browser, client)
    if (header === 'other') {
      const other = await signUp('other-selection@example.test', 'Other')
      header = String((await playerOf(other.uid)).id)
    }
    const response = await browser.request('/api/auth/oauth2/consent', {
      json: { accept: true, oauth_query: page.search.slice(1) },
      ...(header === undefined ? {} : { headers: { 'X-NextSkin-Player': header } }),
    })
    expect(response.status).toBe(400)
    expect((await json(response)).error).toBe('invalid_request')
    expect(await database.db.selectFrom('oauth_consents').select('id').execute()).toEqual([])
  },
)

test('没有 Select 的同意请求不能带角色头，拒绝不受这些检查影响', async () => {
  const { browser, uid } = await signUp('no-select@example.test')
  const client = await createClient(browser, {})
  const page = await consentPage(browser, client, `openid ${READ_SCOPE}`)
  const response = await browser.request('/api/auth/oauth2/consent', {
    json: { accept: true, oauth_query: page.search.slice(1) },
    headers: { 'X-NextSkin-Player': String((await playerOf(uid)).id) },
  })
  expect(response.status).toBe(400)
  expect((await json(response)).error).toBe('invalid_request')
  const denied = await browser.request('/api/auth/oauth2/consent', {
    json: { accept: false, oauth_query: page.search.slice(1) },
    headers: { 'sec-fetch-mode': 'cors', 'X-NextSkin-Player': '0' },
  })
  expect(denied.status).toBe(200)
  expect((await redirectTarget(denied)).searchParams.get('error')).toBe('access_denied')
})

test.each([`openid ${SELECT_SCOPE} ${READ_SCOPE}`, `openid ${JOIN_SCOPE}`, SELECT_SCOPE])(
  '组合错误 %s 只重定向到可信回调，并带 state 和 iss',
  async (scope) => {
    const { browser } = await signUp('scope-error@example.test')
    const client = await createClient(browser, {})
    const { query, state } = authorizationQuery(client, scope)
    const callback = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get('error')).toBe('invalid_scope')
    expect(callback.searchParams.get('state')).toBe(state)
    expect(callback.searchParams.get('iss')).toBe(`${ROOT}/api/auth`)
    query.set('state', '')
    const blank = await redirectTarget(
      await browser.request('/api/auth/oauth2/authorize', { form: Object.fromEntries(query) }),
    )
    expect(blank.searchParams.has('state')).toBe(false)
  },
)

test.each(['invalid_client', 'client_disabled', 'unauthorized_client', 'invalid_redirect'])(
  '不可信的 scope 错误去站内错误页，按顺序得到 %s',
  async (error) => {
    const { browser } = await signUp('untrusted@example.test')
    const client = await createClient(browser, {})
    const { query } = authorizationQuery(client, SELECT_SCOPE)
    if (error === 'invalid_client') query.set('client_id', 'missing')
    if (error === 'client_disabled')
      await database.db
        .updateTable('oauth_clients')
        .set({ disabled: true })
        .where('client_id', '=', client.client_id)
        .execute()
    if (error === 'unauthorized_client')
      await database.db
        .updateTable('oauth_clients')
        .set({ grant_types: JSON.stringify(['refresh_token']) })
        .where('client_id', '=', client.client_id)
        .execute()
    query.set('redirect_uri', 'https://untrusted.example/callback')
    const result = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
    expect(result.pathname).toBe('/oauth/error')
    expect(result.searchParams.get('error')).toBe(error)
    expect(result.searchParams.has('state')).toBe(false)
    expect(result.searchParams.has('iss')).toBe(false)
  },
)

test.each(['http://127.0.0.1:1234/cb', 'http://localhost:1234/cb', 'http://[::1]:1234/cb'])(
  '环回回调 %s 只更换端口仍然可信，URL 其余部分不可变',
  async (registered) => {
    const { browser } = await signUp('loopback@example.test')
    const client = await createClient(browser, {})
    await database.db
      .updateTable('oauth_clients')
      .set({ redirect_uris: JSON.stringify([registered]) })
      .where('client_id', '=', client.client_id)
      .execute()
    const { query } = authorizationQuery(client, SELECT_SCOPE)
    query.set('redirect_uri', registered.replace(':1234/', ':5678/'))
    const target = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
    expect(target.port).toBe('5678')
    expect(target.searchParams.get('error')).toBe('invalid_scope')
    for (const suffix of ['#', '#fragment', '/different']) {
      query.set('redirect_uri', `${registered}${suffix}`)
      const invalid = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
      expect(invalid.pathname).toBe('/oauth/error')
      expect(invalid.searchParams.get('error')).toBe('invalid_redirect')
    }
  },
)

test.each([undefined, '', '   '])('默认 scope（%j）按应用登记补全并去掉 Yggdrasil scope', async (scope) => {
  const { browser } = await signUp('defaults@example.test')
  const client = await createClient(browser, { scope: `openid profile ${SELECT_SCOPE} ${JOIN_SCOPE}` })
  const { query } = authorizationQuery(client, scope)
  const page = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
  expect(page.searchParams.get('scope')).toBe('openid profile')
})

test.each(['create', 'select_account'])('prompt=%s 等同 login，已有会话也跳登录页', async (prompt) => {
  const { browser } = await signUp('prompt@example.test')
  const client = await createClient(browser, {})
  const { query } = authorizationQuery(client, 'openid', prompt)
  const page = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
  expect(page.pathname).toBe('/sign-in')
  expect(page.searchParams.get('prompt')).toBe('login')
})

test.each([
  ['login\t', 'login'],
  ['\tcreate', 'login'],
  ['select_account\t', 'login'],
  ['consent\t login', 'consent login'],
  ['consent\tlogin', null],
] as const)('authorize 的 prompt=%j 按空格拆分后逐项 trim', async (prompt, normalized) => {
  const { browser } = await signUp('prompt-whitespace@example.test')
  const client = await createClient(browser, {})
  const { query } = authorizationQuery(client, 'openid', prompt)
  const page = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
  if (normalized === null) {
    // token 内部的制表符不是分隔符，必须留给 Better Auth 的 schema 拒绝。
    expect(page.searchParams.get('error')).toBe('invalid_request')
    expect(page.host).toBe('app.example.test')
  } else {
    expect(page.pathname).toBe('/sign-in')
    expect(page.searchParams.get('prompt')).toBe(normalized)
  }
})

test.each(['GET', 'POST'])('%s authorize 拒绝 claims 键，包括空串，并重定向到可信回调', async (method) => {
  const { browser } = await signUp('claims-request@example.test')
  const client = await createClient(browser, {})
  for (const claims of ['', JSON.stringify({ userinfo: { email: null, email_verified: null, name: null } })]) {
    const { query, state } = authorizationQuery(client, 'openid')
    query.set('claims', claims)
    const response =
      method === 'GET'
        ? await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`)
        : await browser.request('/api/auth/oauth2/authorize', { form: Object.fromEntries(query) })
    expect(response.status).toBe(302)
    const target = await redirectTarget(response)
    expect(`${target.origin}${target.pathname}`).toBe(CALLBACK)
    expect(target.searchParams.get('error')).toBe('invalid_request')
    expect(target.searchParams.get('error_description')).toBe('The claims parameter is not supported')
    expect(target.searchParams.get('state')).toBe(state)
    expect(target.searchParams.get('iss')).toBe(`${ROOT}/api/auth`)
  }
})

test('同意不能追加未申请的 claims；只有 openid 的 userinfo 不泄露邮箱、验证状态或昵称', async () => {
  const { browser } = await signUp('claims-consent@example.test')
  const client = await createClient(browser, {})
  const page = await consentPage(browser, client, 'openid')
  const consent = await browser.request('/api/auth/oauth2/consent', {
    json: {
      accept: true,
      oauth_query: page.search.slice(1),
      claims: { userinfo: { email: null, email_verified: null, name: null } },
    },
  })
  expect(consent.status).toBe(400)
  expect((await json(consent)).error).toBe('invalid_request')
  expect(await database.db.selectFrom('oauth_consents').select('id').execute()).toEqual([])
  const issued = await browser.request('/api/auth/oauth2/token', { form: await authorize(browser, client, 'openid') })
  expect(issued.status).toBe(200)
  const tokens = await json(issued)
  const response = await browser.request('/api/auth/oauth2/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token as string}` },
  })
  expect(response.status).toBe(200)
  const info = await json(response)
  for (const claim of ['email', 'email_verified', 'name']) expect(info).not.toHaveProperty(claim)
})

test.each(['client_id', 'redirect_uri', 'scope', 'prompt', 'state', 'response_type', 'max_age', 'nonce', 'dpop_jkt'])(
  'authorize 的 %s 重复参数或 DPoP 绑定按错误去向返回 invalid_request',
  async (key) => {
    const { browser } = await signUp('parameter@example.test')
    const client = await createClient(browser, {})
    const { query } = authorizationQuery(client, 'openid')
    if (key === 'dpop_jkt') query.set(key, 'thumbprint')
    else {
      if (!query.has(key)) query.set(key, 'value')
      query.append(key, 'duplicate')
    }
    const response = await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`)
    expect(response.status).toBe(302)
    const target = await redirectTarget(response)
    expect(target.searchParams.get('error')).toBe(
      key === 'client_id' ? 'invalid_client' : key === 'redirect_uri' ? 'invalid_redirect' : 'invalid_request',
    )
  },
)

test.each<Record<string, string>>([{}, { 'sec-fetch-mode': 'cors' }, { accept: 'application/json' }])(
  '授权错误遵守导航或 fetch 的响应格式（%j）',
  async (headers) => {
    const { browser } = await signUp('redirect-format@example.test')
    const client = await createClient(browser, {})
    const { query } = authorizationQuery(client, SELECT_SCOPE)
    const response = await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`, { headers })
    expect(response.status).toBe(Object.keys(headers).length ? 200 : 302)
    if (Object.keys(headers).length) {
      const body = await json(response)
      expect(body.redirect).toBe(true)
      expect(new URL(body.url as string).searchParams.get('error')).toBe('invalid_scope')
    }
  },
)

test('client_id 末尾空格在四库都去 invalid_client，Better Auth 自己的未知应用也去错误页', async () => {
  const { browser } = await signUp('exact-client@example.test')
  const client = await createClient(browser, {})
  for (const id of [`${client.client_id} `, 'missing']) {
    const { query } = authorizationQuery({ ...client, client_id: id }, 'openid')
    const target = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
    expect(target.pathname).toBe('/oauth/error')
    expect(target.searchParams.get('error')).toBe('invalid_client')
  }
  const response = await browser.request('/api/auth/error?error=invalid_client')
  expect(response.status).toBe(302)
  expect((await redirectTarget(response)).pathname).toBe('/oauth/error')
})

test.each(['/sign-in/email', '/sign-up/email'])(
  '非同意端点 %s 不接受 oauth_query，不写会话也不发授权码',
  async (path) => {
    const { browser } = await signUp('query-injection@example.test')
    const client = await createClient(browser, {})
    const { query } = authorizationQuery(client, 'openid')
    const login = await redirectTarget(await new Browser().request(`/api/auth/oauth2/authorize?${query.toString()}`))
    await database.db.deleteFrom('sessions').execute()
    await database.db.deleteFrom('verifications').execute()
    const response = await new Browser().request(`/api/auth${path}`, {
      json: { email: 'query-injection@example.test', password, name: 'Injected', oauth_query: login.search.slice(1) },
    })
    expect(response.status).toBe(400)
    expect((await json(response)).error).toBe('invalid_request')
    expect(await database.db.selectFrom('sessions').select('id').execute()).toEqual([])
    expect(await database.db.selectFrom('verifications').select('id').execute()).toEqual([])
  },
)

test('consentRequest 和 authorizationContinuation 过滤未签名参数，篡改或过期时都拒绝', async () => {
  const { browser } = await signUp('signed-pages@example.test')
  const client = await createClient(browser, {})
  const page = await consentPage(browser, client)
  for (const search of [page.search, page.search.slice(1), `${page.search}&next=ignored&custom=ignored`]) {
    const view = await core.auth.consentRequest(search, ROOT)
    expect(view.status).toBe('ready')
    if (view.status !== 'ready') throw new Error('expected valid consent view')
    expect(view.client).toMatchObject({ clientId: client.client_id, name: 'Example App', shared: false })
    expect(view.redirectHost).toBe('app.example.test')
    expect(new URLSearchParams(view.oauthQuery).has('custom')).toBe(false)
    expect(view.scopes).toEqual(CONNECT_SCOPE.split(' '))
    const continuation = await core.auth.authorizationContinuation(search, new Headers(), ROOT)
    expect(continuation?.resume).toBe(false)
    expect(new URL(continuation!.next, ROOT).searchParams.has('next')).toBe(false)
  }
  const tampered = new URLSearchParams(page.search)
  tampered.set('scope', 'openid')
  const expired = new URLSearchParams(page.search)
  expired.set('exp', String(Math.floor(Date.now() / 1000) - 60))
  for (const search of [
    '',
    '?client_id=missing',
    `${page.search}&sig=extra`,
    tampered.toString(),
    await signedQuery(expired),
  ]) {
    expect((await core.auth.consentRequest(search, ROOT)).status).toBe('invalid')
    expect(await core.auth.authorizationContinuation(search, new Headers(), ROOT)).toBeNull()
  }
})

test.each([undefined, '0', '3600', '1e3', ' 3600 ', '-1', '1.5', 'invalid', ''])(
  '续跑按会话创建时间判断 max_age=%s，并从 next 去掉它',
  async (maxAge) => {
    const { browser, uid } = await signUp('continuation-age@example.test')
    const client = await createClient(browser, {})
    const page = await consentPage(browser, client)
    const params = new URLSearchParams(page.search)
    if (maxAge !== undefined) params.set('max_age', maxAge)
    const search = await signedQuery(params)
    const headers = new Headers({ cookie: browser.cookieHeader(), 'x-nextskin-client-ip': 'spoofed' })
    const result = await core.auth.authorizationContinuation(search, headers, ROOT)
    expect(result?.resume).toBe(maxAge === undefined || ['3600', '1e3', ' 3600 '].includes(maxAge))
    expect(headers.get('x-nextskin-client-ip')).toBe('spoofed')
    const next = new URL(result!.next, ROOT)
    expect(next.pathname).toBe('/api/auth/oauth2/authorize')
    for (const key of ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param', 'max_age'])
      expect(next.searchParams.has(key)).toBe(false)
    expect((await redirectTarget(await browser.request(result!.next))).pathname).toBe('/oauth/consent')
    await database.db
      .updateTable('sessions')
      .set({ created_at: writeAuthDate(database.db, toIsoTimestamp(new Date(Date.now() - 7200_000))) })
      .where('user_id', '=', uid)
      .execute()
    if (maxAge === '3600')
      expect((await core.auth.authorizationContinuation(search, headers, ROOT))?.resume).toBe(false)
  },
)

test.each([
  ['login', false, null],
  ['create', false, null],
  ['select_account', false, null],
  ['login create select_account consent', false, 'consent'],
  ['login\t', false, null],
  ['\tcreate', false, null],
  ['select_account\t', false, null],
  ['consent\t login', false, 'consent'],
  ['consent\tlogin', true, 'consent\tlogin'],
] as const)('续跑按 Better Auth 的语义去掉 prompt=%j 里的登录要求', async (prompt, resume, remaining) => {
  const { browser } = await signUp('continuation-prompt@example.test')
  const client = await createClient(browser, {})
  const page = await consentPage(browser, client)
  const params = new URLSearchParams(page.search)
  params.set('prompt', prompt)
  const result = await core.auth.authorizationContinuation(
    await signedQuery(params),
    new Headers({ cookie: browser.cookieHeader() }),
    ROOT,
  )
  expect(result?.resume).toBe(resume)
  expect(new URL(result!.next, ROOT).searchParams.get('prompt')).toBe(remaining)
})

test.each(['disabled', 'missing', 'grant', 'redirect', 'scope', 'custom'])(
  '同意页验签后仍核对应用、回调和 scope：%s',
  async (condition) => {
    const { browser } = await signUp('consent-view@example.test')
    const client = await createClient(browser, {})
    const page = await consentPage(browser, client)
    const params = new URLSearchParams(page.search)
    if (condition === 'disabled')
      await database.db
        .updateTable('oauth_clients')
        .set({ disabled: true })
        .where('client_id', '=', client.client_id)
        .execute()
    if (condition === 'missing')
      await database.db.deleteFrom('oauth_clients').where('client_id', '=', client.client_id).execute()
    if (condition === 'grant')
      await database.db
        .updateTable('oauth_clients')
        .set({ grant_types: JSON.stringify(['refresh_token']) })
        .where('client_id', '=', client.client_id)
        .execute()
    if (condition === 'redirect') params.set('redirect_uri', 'https://wrong.example/callback')
    if (condition === 'scope') params.set('scope', SELECT_SCOPE)
    if (condition === 'custom') {
      params.set('redirect_uri', 'com.example.app:/callback')
      await database.db
        .updateTable('oauth_clients')
        .set({ redirect_uris: JSON.stringify(['com.example.app:/callback']) })
        .where('client_id', '=', client.client_id)
        .execute()
    }
    const view = await core.auth.consentRequest(await signedQuery(params), ROOT)
    expect(view.status).toBe(condition === 'custom' ? 'ready' : 'invalid')
    if (view.status === 'ready') expect(view.redirectHost).toBe('com.example.app:')
    if (condition === 'disabled' || condition === 'missing') {
      const response = await browser.request('/api/auth/oauth2/consent', {
        json: { accept: true, oauth_query: page.search.slice(1) },
      })
      expect(response.status).toBe(400)
      expect((await json(response)).error).toBe('invalid_client')
      expect(await database.db.selectFrom('oauth_consents').select('id').execute()).toEqual([])
    }
  },
)

test('Auth 实例不可用时两种页面查询都拒绝签名参数', async () => {
  const { browser } = await signUp('unconfigured-view@example.test')
  const client = await createClient(browser, {})
  const page = await consentPage(browser, client)
  const auth = createAuthService({
    db: database.db,
    secretKey,
    production: true,
    settings: core.settings,
    mail: core.mail,
  })
  expect(await auth.authorizationContinuation(page.search, new Headers(), ROOT)).toBeNull()
  expect(await auth.consentRequest(page.search, ROOT)).toEqual({ status: 'invalid' })
})

test('角色头严格拒绝前导空白；Connect 的 consent 钩子只读 oauth-provider 已验签的状态', async () => {
  const { browser, uid } = await signUp('raw-header@example.test')
  const client = await createClient(browser, {})
  const page = await consentPage(browser, client)
  const auth = createAuth({
    db: database.db,
    secretKey,
    siteUrl: ROOT,
    siteName: 'NextSkin',
    legacyPasswordSalt: () => Promise.resolve(''),
  })
  const context = await auth.$context
  const session = await auth.api.getSession({ headers: new Headers({ cookie: browser.cookieHeader() }) })
  const provider = auth.options.plugins.find((plugin) => plugin.id === 'oauth-provider') as ReturnType<
    typeof oauthProvider
  >
  const connect = yggdrasilConnect(
    database.db,
    () => Promise.resolve(10),
    ROOT,
    () => Promise.resolve(false),
  )
  const handler = connect.hooks.before[0]!.handler
  const input = {
    context: { ...context, session },
    path: '/oauth2/consent',
    method: 'POST',
    body: { accept: true, oauth_query: page.search.slice(1) },
    headers: new Headers(),
  }
  const hookInput = input as unknown as Parameters<typeof handler>[0]
  await runWithRequestState(new WeakMap(), async () => {
    await expect(handler(hookInput)).rejects.toMatchObject({ body: { error: 'invalid_request' } })
    await provider.hooks.before[0]!.handler(hookInput)
    // Fetch 的 Headers 会去掉两端空白；直接控制钩子看到的值，验证正则本身不会把它当成合法 pid。
    const pid = String((await playerOf(uid)).id)
    const rawHeader = vi
      .spyOn(input.headers, 'get')
      .mockImplementation((name: string) => (name.toLowerCase() === 'x-nextskin-player' ? ` ${pid}` : null))
    try {
      await expect(handler(hookInput)).rejects.toMatchObject({ body: { error: 'invalid_request' } })
    } finally {
      rawHeader.mockRestore()
    }
    await expect(consentReferenceId({ scopes: ['openid', SELECT_SCOPE] })).rejects.toMatchObject({
      body: { error: 'invalid_request' },
    })
    expect(await consentReferenceId({ scopes: ['openid', READ_SCOPE] })).toBeUndefined()
  })
})

test.each([`openid ${SELECT_SCOPE} ${READ_SCOPE}`, `openid ${JOIN_SCOPE}`, SELECT_SCOPE])(
  'consent 对已签名的非法最终 scope 仍返回 invalid_scope：%s',
  async (scope) => {
    const { browser } = await signUp('final-scope@example.test')
    const client = await createClient(browser, {})
    const page = await consentPage(browser, client)
    const params = new URLSearchParams(page.search)
    params.set('scope', scope)
    const response = await browser.request('/api/auth/oauth2/consent', {
      json: { accept: true, oauth_query: await signedQuery(params) },
    })
    expect(response.status).toBe(400)
    expect((await json(response)).error).toBe('invalid_scope')
    expect(await database.db.selectFrom('oauth_consents').select('id').execute()).toEqual([])
  },
)

test('不选角色的机密客户端已同意时，续跑 next 可以直接发码', async () => {
  const { browser } = await signUp('resume-code@example.test')
  const client = await createClient(browser, {})
  const page = await consentPage(browser, client, 'openid')
  const consent = await browser.request('/api/auth/oauth2/consent', {
    json: { accept: true, oauth_query: page.search.slice(1) },
  })
  expect((await redirectTarget(consent)).searchParams.has('code')).toBe(true)
  const continuation = await core.auth.authorizationContinuation(
    page.search,
    new Headers({ cookie: browser.cookieHeader() }),
    ROOT,
  )
  expect(continuation?.resume).toBe(true)
  expect((await redirectTarget(await browser.request(continuation!.next))).searchParams.has('code')).toBe(true)
})

test.each(['', 'invalid', 'sig=invalid&exp=1'])(
  '非同意端点的 oauth_query=%j 即使没有有效签名也返回 invalid_request',
  async (oauth_query) => {
    const response = await new Browser().request('/api/auth/sign-in/email', {
      json: { email: 'unknown@example.test', password, oauth_query },
    })
    expect(response.status).toBe(400)
    expect((await json(response)).error).toBe('invalid_request')
    expect(await database.db.selectFrom('sessions').select('id').execute()).toEqual([])
  },
)

test.each([null, '[]'])('空 grant_types（%s）按 Better Auth 的隐式授权码规则信任回调', async (grant_types) => {
  const { browser } = await signUp('default-grant@example.test')
  const client = await createClient(browser, {})
  await database.db
    .updateTable('oauth_clients')
    .set({ grant_types })
    .where('client_id', '=', client.client_id)
    .execute()
  const { query } = authorizationQuery(client, SELECT_SCOPE)
  const callback = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
  expect(callback.host).toBe('app.example.test')
  expect(callback.searchParams.get('error')).toBe('invalid_scope')
})

test('授权码流签发 RS256 的 ID 令牌，令牌只以 sha256 存储；带 DPoP proof 的换令牌请求被拒绝', async () => {
  const admin = await signUpAdmin()
  const client = await createClient(admin, {
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['authorization_code', 'refresh_token'],
    scope: 'openid profile offline_access',
  })
  const { browser, uid } = await signUp('steve@example.test')

  const dpop = await new Browser().request('/api/auth/oauth2/token', {
    form: await authorize(browser, client, 'openid profile'),
    headers: { DPoP: 'eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.e30.c2lnbmF0dXJl' },
  })
  expect(dpop.status).toBe(400)
  expect(await json(dpop)).toMatchObject({ error: 'invalid_dpop_proof' })

  const response = await new Browser().request('/api/auth/oauth2/token', {
    form: await authorize(browser, client, 'openid profile offline_access'),
  })
  expect(response.status).toBe(200)
  const tokens = (await response.json()) as { access_token: string; refresh_token: string; id_token: string }
  expect(decodeProtectedHeader(tokens.id_token).alg).toBe('RS256')
  const jwks = await (await new Browser().request('/api/auth/jwks')).json()
  const { payload } = await jwtVerify(
    tokens.id_token,
    createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]),
    {
      issuer: `${ROOT}/api/auth`,
      audience: client.client_id,
    },
  )
  expect(payload.sub).toBe(String(uid))

  const stored = await database.db
    .selectFrom('oauth_access_tokens')
    .select(['token', 'user_id'])
    .where('client_id', '=', client.client_id)
    .execute()
  const digest = createHash('sha256').update(tokens.access_token).digest('base64url')
  expect(stored).toEqual([{ token: digest, user_id: uid }])
  const refresh = await database.db
    .selectFrom('oauth_refresh_tokens')
    .select('token')
    .where('client_id', '=', client.client_id)
    .executeTakeFirstOrThrow()
  expect(refresh.token).toBe(createHash('sha256').update(tokens.refresh_token).digest('base64url'))
})

test('发现文档位于 issuer 之下，不宣称 private_key_jwt 和 DPoP', async () => {
  const response = await new Browser().request('/api/auth/.well-known/openid-configuration')
  expect(response.status).toBe(200)
  const metadata = await json(response)
  expect(metadata.issuer).toBe(`${ROOT}/api/auth`)
  expect(metadata.token_endpoint).toBe(`${ROOT}/api/auth/oauth2/token`)
  expect(metadata.id_token_signing_alg_values_supported).toEqual(['RS256'])
  expect(metadata.token_endpoint_auth_methods_supported).not.toContain('private_key_jwt')
  expect(metadata.introspection_endpoint_auth_methods_supported).not.toContain('private_key_jwt')
  expect(metadata.claims_parameter_supported).toBe(false)
  expect(metadata).not.toHaveProperty('dpop_signing_alg_values_supported')
  expect(metadata).not.toHaveProperty('token_endpoint_auth_signing_alg_values_supported')
})

test.each([
  ['POST', '/api/auth/sign-in/magic-link'],
  ['POST', '/api/auth/email-otp/send-verification-otp'],
  ['GET', '/api/auth/siwe/nonce'],
  ['GET', '/api/auth/token'],
  ['POST', '/api/auth/update-user'],
])('没有启用或已关闭的端点 %s %s 返回 404', async (method, path) => {
  const { browser } = await signUp('steve@example.test')
  const response = await browser.request(path, { method, ...(method === 'POST' ? { json: {} } : {}) })
  expect(response.status).toBe(404)
})

test('站点地址是 https 时会话 Cookie 带 Secure 和 __Secure- 前缀', async () => {
  await storeSetting('site.url', 'https://skin.example.test/')
  const site = 'https://skin.example.test'
  await core.users.register({
    email: 'secure@example.test',
    password,
    playerName: 'Secure',
    ip: '127.0.0.1',
    locale: null,
  })
  const response = await new Browser(core, site).request('/api/auth/sign-in/email', {
    json: { email: 'secure@example.test', password },
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.getSetCookie().find((value) => value.includes('session_token='))
  expect(cookie).toMatch(/^__Secure-nextskin\.session_token=/)
  expect(cookie).toMatch(/; Secure/)
  // 发现文档的 issuer 取自设置，而不是请求的地址
  const metadata = await json(await new Browser(core, ROOT).request('/api/auth/.well-known/openid-configuration'))
  expect(metadata.issuer).toBe(`${site}/api/auth`)
})

test('生产环境没有设置站点地址时拒绝处理认证请求，不信任请求的 Host', async () => {
  const production = createCore({
    db: database.db,
    secretKey,
    production: true,
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
  const response = await new Browser(production).request('/api/auth/sign-up/email', {
    json: { email: 'steve@example.test', password, name: 'Steve' },
  })
  expect(response.status).toBe(503)
  expect(await production.auth.openIdConfigurationUrl('https://request.example.test')).toBeNull()
  expect(await json(response)).toMatchObject({ error: 'site_url_required' })
  expect(await database.db.selectFrom('users').select('id').execute()).toEqual([])
})

test.each(['198.51.100.10', null])('handle 保留登录请求体并替换或删除伪造的内部 IP：%s', async (clientIp) => {
  const { uid } = await core.users.register({
    email: 'ip@example.test',
    password,
    playerName: 'IpTest',
    ip: '192.0.2.1',
    locale: null,
  })
  const response = await core.auth.handle(
    new Request(`${LISTEN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        origin: ROOT,
        'content-type': 'application/json',
        'x-nextskin-client-ip': '203.0.113.99',
        'x-forwarded-for': '203.0.113.88',
      },
      body: JSON.stringify({ email: 'ip@example.test', password }),
    }),
    ROOT,
    clientIp,
  )
  expect(response.status).toBe(200)
  const session = await database.db
    .selectFrom('sessions')
    .select(['ip_address', 'user_id'])
    .where('user_id', '=', uid)
    .executeTakeFirstOrThrow()
  // Better Auth 在开发/测试环境缺 IP 时退回回环地址，不能使用伪造值。
  expect(session.ip_address).toBe(clientIp ?? '127.0.0.1')
})

test('createSession 复用登录 Cookie，记 IP 与 User-Agent，站点 URL 未配置时拒绝', async () => {
  await storeSetting('site.url', 'https://skin.example.test')
  const { uid } = await core.users.register({
    email: 'session@example.test',
    password,
    playerName: 'Session',
    ip: '192.0.2.1',
    locale: null,
  })
  const cookies = await core.auth.createSession({
    email: ' Session@Example.test ',
    password,
    clientIp: '198.51.100.20',
    userAgent: 'session-test',
    requestRoot: ROOT,
  })
  expect(
    cookies.some(
      (cookie) =>
        /^__Secure-nextskin\.session_token=/.test(cookie) &&
        /; HttpOnly/i.test(cookie) &&
        /; Secure/i.test(cookie) &&
        /; SameSite=Lax/i.test(cookie),
    ),
  ).toBe(true)
  const headers = new Headers({
    cookie: cookies.map((value) => value.split(';')[0]).join('; '),
    'x-nextskin-client-ip': '203.0.113.99',
  })
  expect(await core.auth.getSessionUser(headers, ROOT)).toMatchObject({ uid })
  expect(headers.get('x-nextskin-client-ip')).toBe('203.0.113.99')
  expect(
    await database.db
      .selectFrom('sessions')
      .select(['ip_address', 'user_agent'])
      .where('user_id', '=', uid)
      .executeTakeFirstOrThrow(),
  ).toEqual({ ip_address: '198.51.100.20', user_agent: 'session-test' })
  await database.db.deleteFrom('settings').execute()
  const production = createCore({
    db: database.db,
    secretKey,
    production: true,
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
  await expect(
    production.auth.createSession({
      email: 'session@example.test',
      password,
      clientIp: '198.51.100.20',
      userAgent: null,
      requestRoot: ROOT,
    }),
  ).rejects.toThrow('site_url_required')
})

test('授权码缺省 scope 经同意页内部续跑后仍不包含 Yggdrasil scope', async () => {
  const admin = await signUpAdmin()
  const client = await createClient(admin, {})
  const { browser } = await signUp('default-scopes@example.test')
  const response = await new Browser().request('/api/auth/oauth2/token', { form: await authorize(browser, client) })
  expect(response.status).toBe(200)
  const body = await json(response)
  expect(body.scope).toBe('openid profile email offline_access')
})

test.each(['banned', 'unverified'] as const)(
  'authorize 把 %s 的现有会话送到同意页，consent 拒绝接受但允许拒绝',
  async (condition) => {
    const { browser, uid } = await signUp('authorization@example.test', 'Steve')
    const client = await createClient(browser, {})
    const { query } = authorizationQuery(client, 'openid profile')
    const consentPage = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
    expect(consentPage.pathname).toBe('/oauth/consent')
    if (condition === 'banned')
      await database.db.updateTable('users').set({ role: 'banned' }).where('id', '=', uid).execute()
    else await storeSetting('auth.requireEmailVerification', true)
    for (const method of ['GET', 'POST']) {
      const response =
        method === 'GET'
          ? await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`)
          : await browser.request('/api/auth/oauth2/authorize', { form: Object.fromEntries(query) })
      const blockedPage = await redirectTarget(response)
      expect(blockedPage.pathname).toBe('/oauth/consent')
      expect(blockedPage.searchParams.get('prompt')?.split(' ')).toContain('consent')
    }
    const consent = await browser.request('/api/auth/oauth2/consent', {
      json: { accept: true, oauth_query: consentPage.search.slice(1) },
    })
    expect(consent.status).toBe(403)
    expect(await json(consent)).toMatchObject({ error: 'access_denied' })
    const denied = await redirectTarget(
      await browser.request('/api/auth/oauth2/consent', {
        json: { accept: false, oauth_query: consentPage.search.slice(1) },
      }),
    )
    expect(denied.searchParams.get('error')).toBe('access_denied')
    query.set('prompt', 'none')
    const silent = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
    expect(silent.searchParams.get('error')).toBe('access_denied')
    expect(silent.searchParams.get('state')).toBe(query.get('state'))
    expect(silent.searchParams.get('iss')).toBe(`${ROOT}/api/auth`)
    expect(await database.db.selectFrom('oauth_consents').select('id').execute()).toEqual([])
  },
)

test('consent 拒绝部分 scope，同集合的重排和重复 scope 可以同意', async () => {
  const { browser } = await signUp('consent@example.test', 'Steve')
  const client = await createClient(browser, {})
  const { query } = authorizationQuery(client, 'openid profile')
  const page = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
  const oauth_query = page.search.slice(1)
  const response = await browser.request('/api/auth/oauth2/consent', {
    json: { accept: true, scope: 'openid', oauth_query },
  })
  expect(response.status).toBe(400)
  expect(await json(response)).toMatchObject({ error: 'invalid_scope' })
  expect(await database.db.selectFrom('oauth_consents').select('id').execute()).toEqual([])
  const callback = await redirectTarget(
    await browser.request('/api/auth/oauth2/consent', {
      json: { accept: true, scope: 'profile openid openid', oauth_query },
    }),
  )
  expect(callback.searchParams.has('code')).toBe(true)
})

test('公共客户端每次 authorize 都要求同意，内部续跑拿到 code 并可兑换令牌', async () => {
  const { browser } = await signUp('public@example.test', 'Steve')
  const client = await createClient(browser, {
    token_endpoint_auth_method: 'none',
    scope: 'openid profile offline_access',
  })
  // 第一次不带 scope，同时覆盖默认 scope 和 prompt 的合并改写。
  const grant = await authorize(browser, client)
  const response = await new Browser().request('/api/auth/oauth2/token', {
    form: {
      grant_type: grant.grant_type,
      client_id: grant.client_id,
      code: grant.code,
      code_verifier: grant.code_verifier,
      redirect_uri: grant.redirect_uri,
    },
  })
  expect(response.status).toBe(200)
  expect(await json(response)).toMatchObject({
    access_token: expect.any(String) as unknown,
    refresh_token: expect.any(String) as unknown,
    id_token: expect.any(String) as unknown,
  })
  const { query } = authorizationQuery(client, 'openid profile')
  const page = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
  expect(page.pathname).toBe('/oauth/consent')
  expect(page.searchParams.get('prompt')?.split(' ')).toContain('consent')
  // POST 的外部授权同样强制同意。
  const posted = await redirectTarget(
    await browser.request('/api/auth/oauth2/authorize', { form: Object.fromEntries(query) }),
  )
  expect(posted.pathname).toBe('/oauth/consent')
})

test('公共客户端已有同意时 prompt=none 仍返回 consent_required', async () => {
  const { browser } = await signUp('silent@example.test', 'Steve')
  const client = await createClient(browser, { token_endpoint_auth_method: 'none' })
  await authorize(browser, client, 'openid profile')
  const { query } = authorizationQuery(client, 'openid profile', 'none')
  const response = await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`)
  expect(response.status).toBe(302)
  expect((await redirectTarget(response)).searchParams.get('error')).toBe('consent_required')
})

test.each(['banned', 'revokeLogins'] as const)('同意之后 %s 再换授权码返回 invalid_grant，不留令牌', async (action) => {
  const { browser, uid } = await signUp('code@example.test', 'Steve')
  const client = await createClient(browser, {})
  const grant = await authorize(browser, client, 'openid offline_access')
  if (action === 'banned')
    await database.db.updateTable('users').set({ role: 'banned' }).where('id', '=', uid).execute()
  else
    await transactionWithRetry(database.db, async (tx) => {
      await tx
        .updateTable('users')
        .set((eb) => ({ role: eb.ref('role') }))
        .where('id', '=', uid)
        .execute()
      await revokeLogins(tx, uid)
    })
  const response = await new Browser().request('/api/auth/oauth2/token', { form: grant })
  expect(response.status).toBe(400)
  expect(await json(response)).toMatchObject({ error: 'invalid_grant' })
  expect(await database.db.selectFrom('oauth_access_tokens').select('id').execute()).toEqual([])
  expect(await database.db.selectFrom('oauth_refresh_tokens').select('id').execute()).toEqual([])
})
