import { createHash, randomBytes } from 'node:crypto'
import { coreMigrations, migrateToLatest, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createCore, encodeSettingValue, type Core, type CoreSettingKey, type CoreSettingValue } from '../index.ts'
import { isLegacyPasswordHash } from './legacy-passwords.ts'

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
  core = createCore({
    db: database.db,
    secretKey,
    production: false,
    textureStorage: { read: () => Promise.resolve(null) },
  })
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  // 外键会级联删掉会话、账号、客户端和令牌
  await database.db.deleteFrom('oauth_clients').execute()
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
    const response = await this.target.auth.handle(
      new Request(new URL(path, LISTEN), { method, headers, body }),
      this.root,
    )
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
  if (typeof body.url !== 'string') throw new Error(`expected a redirect, got ${response.status}`)
  return new URL(body.url, ROOT)
}

const password = 'correct horse battery staple'

async function signUp(email: string, name = 'Steve') {
  const browser = new Browser()
  const response = await browser.request('/api/auth/sign-up/email', { json: { email, password, name } })
  expect(response.status).toBe(200)
  const body = await json(response)
  return { browser, uid: Number((body.user as { id: string }).id) }
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

async function createClient(admin: Browser, body: Record<string, unknown>): Promise<CreatedClient> {
  const response = await admin.request('/api/auth/oauth2/create-client', {
    json: { client_name: 'Example App', redirect_uris: [CALLBACK], ...body },
  })
  expect(response.status).toBe(201)
  return (await response.json()) as CreatedClient
}

function basic(clientId: string, secret: string) {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`
}

test('注册和登录：整数 uid、邮箱转小写、会话 Cookie 是 HttpOnly + SameSite=Lax', async () => {
  const browser = new Browser()
  const response = await browser.request('/api/auth/sign-up/email', {
    json: { email: 'Steve@Example.TEST', password, name: 'Steve' },
  })
  expect(response.status).toBe(200)
  const uid = Number(((await json(response)).user as { id: string }).id)
  expect(Number.isSafeInteger(uid)).toBe(true)
  const row = await database.db.selectFrom('users').selectAll().where('id', '=', uid).executeTakeFirstOrThrow()
  expect(row).toMatchObject({ email: 'steve@example.test', nickname: 'Steve', role: 'user', score: 0 })

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

test('getSessionUser 返回 uid、昵称和角色；没有会话时返回 null', async () => {
  const { browser, uid } = await signUp('alex@example.test', 'Alex')
  expect(await core.auth.getSessionUser(new Headers({ cookie: browser.cookieHeader() }), ROOT)).toEqual({
    uid,
    nickname: 'Alex',
    email: 'alex@example.test',
    role: 'user',
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

test('只有管理员能管理 OAuth 客户端', async () => {
  const { browser } = await signUp('user@example.test')
  const response = await browser.request('/api/auth/oauth2/create-client', {
    json: { client_name: 'Example App', redirect_uris: [CALLBACK] },
  })
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(response.status).toBeLessThan(500)
  expect(await database.db.selectFrom('oauth_clients').select('id').execute()).toEqual([])
})

// Better Auth 会先 trim 再校验认证方式，前后带空白的值同样会被存成 private_key_jwt（独立审核发现）
test.each(['private_key_jwt', ' private_key_jwt ', 'private_key_jwt\n', 'PRIVATE_KEY_JWT', 'tls_client_auth'])(
  '创建和修改客户端时只接受白名单里的认证方式，拒绝 %j（ADR-0015：serial 下 private_key_jwt 的防重放不起作用）',
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
    expect(create.status).toBe(400)
    expect((await json(create)).error).toBe('invalid_client_metadata')

    const client = await createClient(admin, { token_endpoint_auth_method: 'client_secret_post' })
    const update = await admin.request('/api/auth/oauth2/update-client', {
      json: { client_id: client.client_id, update: { token_endpoint_auth_method: method } },
    })
    expect(update.status).toBe(400)
    const rows = await database.db.selectFrom('oauth_clients').select('token_endpoint_auth_method').execute()
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

/** 授权码流走到拿到授权码为止：authorize → 同意页 → 回调 */
async function authorize(browser: Browser, client: CreatedClient, scope: string) {
  const proof = pkce()
  const state = randomBytes(8).toString('hex')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    scope,
    state,
    code_challenge: proof.challenge,
    code_challenge_method: 'S256',
  })
  const consentPage = await redirectTarget(await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`))
  expect(consentPage.pathname).toBe('/oauth/consent')
  const callback = await redirectTarget(
    await browser.request('/api/auth/oauth2/consent', {
      json: { accept: true, oauth_query: consentPage.search.slice(1) },
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
  const response = await new Browser(core, site).request('/api/auth/sign-up/email', {
    json: { email: 'secure@example.test', password, name: 'Secure' },
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
    textureStorage: { read: () => Promise.resolve(null) },
  })
  const response = await new Browser(production).request('/api/auth/sign-up/email', {
    json: { email: 'steve@example.test', password, name: 'Steve' },
  })
  expect(response.status).toBe(503)
  expect(await json(response)).toMatchObject({ error: 'site_url_required' })
  expect(await database.db.selectFrom('users').select('id').execute()).toEqual([])
})
