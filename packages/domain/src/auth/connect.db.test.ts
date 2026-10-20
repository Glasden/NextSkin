import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  readAuthDate,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import type { OAuthExtensionGrantHandler, oauthProvider } from '@better-auth/oauth-provider'
import type { BetterAuthPlugin } from 'better-auth'
import { dispatchAuthEndpoint, type DispatchContext } from 'better-auth/api'
import { RENDERER_VERSION } from '@nextskin/skin'
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JSONWebKeySet } from 'jose'
import { afterAll, beforeAll, beforeEach, expect, test, vi, type MockInstance } from 'vitest'
import { createCore, encodeSettingValue, type Core, type CoreSettingKey, type CoreSettingValue } from '../index.ts'
import { DEVICE_CODE_GRANT_TYPE, OAUTH_SCOPES, READ_SCOPE, SELECT_SCOPE } from '../oauth/scopes.ts'
import { markSiteInitialized } from '../setup/initialized.test-helper.ts'
import { createAuthService } from './service.ts'
import { Browser } from './security.test-helper.ts'
import { authOptions, createAuth, sha256 } from './auth.ts'

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const ROOT = 'https://skin.example.test'
const SCOPE = `openid offline_access ${SELECT_SCOPE} Yggdrasil.Server.Join`
let database: TestDatabase<CoreDatabase>
let core: Core
let uid: number
let pid: number

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
      write: async () => {},
      delete: async () => {},
      deleteTemp: async () => {},
      read: () => Promise.resolve(null),
    },
  })
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await database.db.deleteFrom('device_code_selections').execute()
  await database.db.deleteFrom('device_codes').execute()
  await database.db.deleteFrom('oauth_access_tokens').execute()
  await database.db.deleteFrom('oauth_refresh_tokens').execute()
  await database.db.deleteFrom('oauth_clients').where('client_id', '!=', 'shared').execute()
  await database.db.updateTable('oauth_clients').set({ disabled: false }).where('client_id', '=', 'shared').execute()
  await database.db.deleteFrom('users').execute()
  await database.db.deleteFrom('settings').execute()
  await setting('site.url', ROOT)
  const user = await core.users.register({
    email: 'connect@example.test',
    password: 'correct horse battery staple',
    playerName: 'Steve',
    ip: '127.0.0.1',
    locale: null,
  })
  uid = user.uid
  pid = (await database.db.selectFrom('players').select('id').where('user_id', '=', uid).executeTakeFirstOrThrow()).id
})

async function setting<K extends CoreSettingKey>(key: K, value: CoreSettingValue<K>) {
  await database.db.deleteFrom('settings').where('key', '=', key).execute()
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

async function request(
  path: string,
  form?: Record<string, string> | string,
  headers: Record<string, string> = {},
  method?: string,
) {
  return core.auth.handle(
    new Request(`http://127.0.0.1:3000/api/auth${path}`, {
      method: method ?? (form === undefined ? 'GET' : 'POST'),
      headers: {
        origin: ROOT,
        ...(form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: form === undefined ? undefined : typeof form === 'string' ? form : new URLSearchParams(form).toString(),
    }),
    ROOT,
    '127.0.0.1',
  )
}
async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>
}
interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}
interface Tokens {
  access_token: string
  refresh_token: string
  id_token: string
  expires_in: number
  scope: string
}
async function device(scope = SCOPE, clientId = 'shared') {
  const response = await request('/device/code', { client_id: clientId, scope })
  expect(response.status).toBe(200)
  return (await response.json()) as DeviceCode
}
async function approve(code: DeviceCode, selected = true, owner = uid) {
  await database.db
    .updateTable('device_codes')
    .set({
      status: 'approved',
      user_id: String(owner),
      last_polled_at: writeAuthDate(database.db, toIsoTimestamp(new Date(Date.now() - 6000))),
    })
    .where('device_code', '=', code.device_code)
    .execute()
  if (selected)
    await database.db
      .insertInto('device_code_selections')
      .values({ device_code: code.device_code, user_id: owner, player_id: pid, created_at: toIsoTimestamp(new Date()) })
      .execute()
}
async function poll(code: DeviceCode, clientId = 'shared') {
  return request('/oauth2/token', {
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: code.device_code,
    client_id: clientId,
  })
}
async function issue(scope = SCOPE, clientId = 'shared', owner = uid) {
  const code = await device(scope, clientId)
  await approve(code, scope.includes(SELECT_SCOPE), owner)
  const response = await poll(code, clientId)
  expect(response.status).toBe(200)
  return (await response.json()) as Tokens
}
async function refresh(tokens: Tokens, extra: Record<string, string> = {}) {
  return request('/oauth2/token', {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: 'shared',
    ...extra,
  })
}
async function info(tokens: Tokens) {
  return request('/oauth2/userinfo', undefined, { authorization: `Bearer ${tokens.access_token}` })
}
async function importedClient(clientId = '1514') {
  await database.db
    .insertInto('oauth_clients')
    .values({
      client_id: clientId,
      token_endpoint_auth_method: 'none',
      redirect_uris: '[]',
      scopes: null,
      grant_types: JSON.stringify([DEVICE_CODE_GRANT_TYPE, 'refresh_token']),
      disabled: false,
      require_pkce: true,
    })
    .execute()
  return clientId
}

test('PCL-CE / SJMCL / FluentCore：公用应用设备码、RS256 签名、角色绑定和 userinfo', async () => {
  await setting('yggdrasil.tokenValidSeconds', 12345)
  await setting('yggdrasil.tokenRefreshableSeconds', 100)
  const code = await device(`${SCOPE} profile`)
  expect(code).toMatchObject({ expires_in: 600, interval: 5, verification_uri: `${ROOT}/device` })
  expect(new URL(code.verification_uri_complete).searchParams.get('user_code')).toBe(code.user_code)
  await approve(code)
  const response = await poll(code)
  expect(response.status).toBe(200)
  const tokens = (await response.json()) as Tokens
  expect(tokens.expires_in).toBe(12345)
  expect(tokens.refresh_token).toEqual(expect.any(String))
  const refreshRow = await database.db
    .selectFrom('oauth_refresh_tokens')
    .selectAll()
    .where('token', '=', sha256(tokens.refresh_token))
    .executeTakeFirstOrThrow()
  expect(
    new Date(readAuthDate(refreshRow.expires_at)).getTime() - new Date(readAuthDate(refreshRow.created_at)).getTime(),
  ).toBe(12345 * 1000)
  const jwks = (await (await request('/jwks')).json()) as JSONWebKeySet
  expect(jwks.keys).toHaveLength(1)
  expect(jwks.keys[0]!.kid).toBe(decodeProtectedHeader(tokens.id_token).kid)
  const claims = (
    await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), { audience: 'shared', issuer: `${ROOT}/api/auth` })
  ).payload
  await jwtVerify(tokens.id_token, await importJWK(jwks.keys[0]!, 'RS256'), { audience: 'shared' })
  const player = await database.db.selectFrom('players').selectAll().where('id', '=', pid).executeTakeFirstOrThrow()
  expect(claims).toMatchObject({
    sub: String(uid),
    name: 'Steve',
    selectedProfile: { id: player.uuid.replaceAll('-', ''), name: 'Steve' },
  })
  expect(claims).not.toHaveProperty('picture')
  expect(Number(claims.exp) - Number(claims.iat)).toBe(12345)
  const row = await database.db
    .selectFrom('oauth_access_tokens')
    .selectAll()
    .where('token', '=', sha256(tokens.access_token))
    .executeTakeFirstOrThrow()
  expect(row.reference_id).toBe(`player:${pid}`)
  expect(await database.db.selectFrom('device_code_selections').selectAll().execute()).toEqual([])
  await database.db.updateTable('players').set({ name: 'Renamed' }).where('id', '=', pid).execute()
  await database.db
    .updateTable('users')
    .set({ nickname: 'Two Names', image: 'https://wrong.example/avatar' })
    .where('id', '=', uid)
    .execute()
  const userinfo = await info(tokens)
  expect(userinfo.status).toBe(200)
  expect(userinfo.headers.get('cache-control')).toContain('no-store')
  const body = await json(userinfo)
  expect(body).toMatchObject({
    aud: 'shared',
    sub: String(uid),
    name: 'Two Names',
    selectedProfile: { name: 'Renamed' },
  })
  for (const key of ['given_name', 'family_name', 'picture', 'iss', 'iat', 'exp']) expect(body).not.toHaveProperty(key)
  await setting('yggdrasil.tokenValidSeconds', 23456)
  expect((await issue()).expires_in).toBe(23456)
})

test('导入的公共客户端和 Read、email、profile 声明', async () => {
  const clientId = await importedClient()
  await core.players.create({ uid }, { name: 'Second' })
  const tokens = await issue(`openid profile email offline_access ${READ_SCOPE}`, clientId)
  const player = await database.db.selectFrom('players').selectAll().where('id', '=', pid).executeTakeFirstOrThrow()
  const second = await database.db
    .selectFrom('players')
    .selectAll()
    .where('name', '=', 'Second')
    .executeTakeFirstOrThrow()
  const profiles = [player, second].map((row) => ({ id: row.uuid.replaceAll('-', ''), name: row.name }))
  expect(decodeJwt(tokens.id_token)).toMatchObject({
    aud: clientId,
    availableProfiles: profiles,
    email: 'connect@example.test',
    email_verified: false,
  })
  expect(await json(await info(tokens))).toMatchObject({ aud: clientId, availableProfiles: profiles })
})

test('刷新签发新 ID / refresh 令牌、删除旧访问令牌，重放作废整组', async () => {
  const tokens = await issue()
  const invalid = await refresh(tokens, { scope: `openid ${SELECT_SCOPE} ${READ_SCOPE}` })
  expect(invalid.status).toBe(400)
  expect(await json(invalid)).toMatchObject({ error: 'invalid_scope' })
  const missingClient = await request('/oauth2/token', {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  })
  expect(missingClient.status).toBe(400)
  expect(await json(missingClient)).toMatchObject({ error: 'invalid_request' })
  const response = await refresh(tokens)
  expect(response.status).toBe(200)
  const next = (await response.json()) as Tokens
  expect(next.refresh_token).not.toBe(tokens.refresh_token)
  expect(next.id_token).toEqual(expect.any(String))
  expect(decodeJwt(next.id_token).selectedProfile).toEqual(decodeJwt(tokens.id_token).selectedProfile)
  expect(
    await database.db
      .selectFrom('oauth_access_tokens')
      .select('id')
      .where('token', '=', sha256(tokens.access_token))
      .execute(),
  ).toEqual([])
  const replay = await refresh(tokens)
  expect(replay.status).toBe(400)
  expect(await json(replay)).toMatchObject({ error: 'invalid_grant' })
  expect((await info(next)).status).toBe(401)
})

test.each([
  SELECT_SCOPE,
  `openid ${SELECT_SCOPE} ${READ_SCOPE}`,
  'openid Yggdrasil.Server.Join',
  'openid unknown',
  '',
  'openid email',
])('设备请求 scope 规则：%j', async (scope) => {
  const response = await request('/device/code', { client_id: 'shared', ...(scope ? { scope } : {}) })
  expect(response.status).toBe(400)
  expect(await json(response)).toMatchObject({ error: 'invalid_scope' })
})

test('重复 scope 参数按端点最终值检查，不能靠最后一个空串绕过', async () => {
  const response = await request(
    '/device/code',
    `client_id=shared&scope=${encodeURIComponent('openid Yggdrasil.Server.Join')}&scope=`,
  )
  expect(response.status).toBe(400)
  expect(await json(response)).toMatchObject({ error: 'invalid_scope' })
})

test.each(['user_id=5&user_id=', 'user_id=', 'json'])('不接受客户端认领用户：%s', async (input) => {
  const response =
    input === 'json'
      ? await core.auth.handle(
          new Request(`${ROOT}/api/auth/device/code`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_id: 'shared', scope: SCOPE, user_id: '' }),
          }),
          ROOT,
          null,
        )
      : await request('/device/code', `client_id=shared&scope=${encodeURIComponent(SCOPE)}&${input}`)
  expect(response.status).toBe(400)
  expect(await json(response)).toMatchObject({ error: 'invalid_request' })
})

test('device/code 拒绝 client_assertion，未知客户端不能获取设备码', async () => {
  const response = await request('/device/code', {
    client_id: 'shared',
    scope: SCOPE,
    client_assertion: 'e30.e30.signature',
  })
  expect(response.status).toBe(400)
  expect(await json(response)).toMatchObject({ error: 'invalid_client' })
  expect((await request('/device/code', { client_id: 'missing', scope: SCOPE })).status).toBe(400)
})

test.each(['missing', 'transferred', 'wrong-user'])(
  'Select 兑换前的选择无效（%s），不写令牌，清理选择',
  async (scenario) => {
    const code = await device()
    await approve(code, scenario !== 'missing')
    if (scenario === 'transferred')
      await database.db
        .updateTable('players')
        .set({ user_id: await otherUser() })
        .where('id', '=', pid)
        .execute()
    if (scenario === 'wrong-user')
      await database.db
        .updateTable('device_code_selections')
        .set({ user_id: await otherUser() })
        .where('device_code', '=', code.device_code)
        .execute()
    const response = await poll(code)
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: 'invalid_grant' })
    expect(await database.db.selectFrom('oauth_access_tokens').selectAll().execute()).toEqual([])
    expect(await database.db.selectFrom('oauth_refresh_tokens').selectAll().execute()).toEqual([])
    expect(await database.db.selectFrom('device_code_selections').selectAll().execute()).toEqual([])
  },
)

test('pending / slow_down 轮询保留选择', async () => {
  const code = await device()
  await database.db
    .insertInto('device_code_selections')
    .values({ device_code: code.device_code, user_id: uid, player_id: pid, created_at: toIsoTimestamp(new Date()) })
    .execute()
  const first = await poll(code)
  expect(await json(first)).toMatchObject({ error: 'authorization_pending' })
  expect(await json(await poll(code))).toMatchObject({ error: 'slow_down' })
  expect(await database.db.selectFrom('device_code_selections').selectAll().execute()).toHaveLength(1)
})

test('每个用户每个应用保留最新 N 对令牌，同秒签发按 id 排序', async () => {
  await setting('yggdrasil.tokensPerUser', 2)
  const otherClient = await importedClient()
  const unrelated = await issue(SCOPE, otherClient)
  const otherOwner = await otherUser()
  const unrelatedUser = await issue('openid offline_access', 'shared', otherOwner)
  const first = await issue()
  await issue()
  await issue()
  expect(
    await database.db
      .selectFrom('oauth_access_tokens')
      .select('id')
      .where('client_id', '=', 'shared')
      .where('user_id', '=', uid)
      .execute(),
  ).toHaveLength(2)
  expect(
    await database.db
      .selectFrom('oauth_refresh_tokens')
      .select('id')
      .where('token', '=', sha256(first.refresh_token))
      .execute(),
  ).toEqual([])
  expect((await info(first)).status).toBe(401)
  expect((await info(unrelated)).status).toBe(200)
  expect((await info(unrelatedUser)).status).toBe(200)
})

test('封禁时刷新、userinfo、设备兑换都拒绝；已有令牌保留，解封恢复', async () => {
  const tokens = await issue()
  const code = await device()
  await approve(code)
  await database.db.updateTable('users').set({ role: 'banned' }).where('id', '=', uid).execute()
  const response = await refresh(tokens)
  expect(await json(response)).toMatchObject({ error: 'invalid_grant' })
  const userinfo = await info(tokens)
  expect(userinfo.status).toBe(401)
  expect(userinfo.headers.get('www-authenticate')).toBe(
    'Bearer error="invalid_token", error_description="Invalid access token"',
  )
  expect(await json(userinfo)).toEqual({ error: 'invalid_token', error_description: 'Invalid access token' })
  expect(await json(await poll(code))).toMatchObject({ error: 'invalid_grant' })
  expect(await database.db.selectFrom('oauth_refresh_tokens').select('id').execute()).toHaveLength(1)
  await database.db.updateTable('users').set({ role: 'user' }).where('id', '=', uid).execute()
  expect((await refresh(tokens)).status).toBe(200)
})

test.each(['access_token', 'refresh_token'] as const)('revoke %s 删除配对的访问和刷新令牌', async (kind) => {
  const tokens = await issue()
  expect((await request('/oauth2/revoke', { token: tokens[kind], client_id: 'shared' })).status).toBe(200)
  expect(await database.db.selectFrom('oauth_access_tokens').select('id').execute()).toEqual([])
  const refresh = await database.db.selectFrom('oauth_refresh_tokens').select('revoked').execute()
  if (kind === 'access_token') expect(refresh).toEqual([])
  else expect(refresh[0]?.revoked).not.toBeNull()
})

test('发现文档过滤不支持的能力，公用应用停用后不公布 client_id', async () => {
  const path = '/.well-known/openid-configuration'
  const response = await request(path)
  const metadata = await json(response)
  expect(metadata).toMatchObject({
    issuer: `${ROOT}/api/auth`,
    token_endpoint: `${ROOT}/api/auth/oauth2/token`,
    userinfo_endpoint: `${ROOT}/api/auth/oauth2/userinfo`,
    jwks_uri: `${ROOT}/api/auth/jwks`,
    device_authorization_endpoint: `${ROOT}/api/auth/device/code`,
    shared_client_id: 'shared',
    scopes_supported: OAUTH_SCOPES,
    grant_types_supported: ['authorization_code', 'refresh_token', DEVICE_CODE_GRANT_TYPE],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  })
  expect(metadata.token_endpoint_auth_methods_supported).toContain('none')
  expect(metadata.token_endpoint_auth_methods_supported).not.toContain('private_key_jwt')
  expect(metadata.claims_supported).toEqual(expect.arrayContaining(['selectedProfile', 'availableProfiles']))
  expect(metadata.prompt_values_supported).not.toEqual(expect.arrayContaining(['select_account', 'create']))
  for (const key of [
    'registration_endpoint',
    'end_session_endpoint',
    'backchannel_logout_supported',
    'backchannel_logout_session_supported',
    'dpop_signing_alg_values_supported',
  ])
    expect(metadata).not.toHaveProperty(key)
  expect(response.headers.get('cache-control')).toContain('max-age=15')
  const head = await request(path, undefined, {}, 'HEAD')
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  const issued = await issue()
  await database.db.updateTable('oauth_clients').set({ disabled: true }).where('client_id', '=', 'shared').execute()
  const disabled = await request('/device/code', { client_id: 'shared', scope: SCOPE })
  expect(await json(disabled)).toMatchObject({ error: 'invalid_client' })
  expect((await info(issued)).status).toBe(401)
  expect(await core.auth.openIdConfigurationUrl('http://request.example.test')).toBe(
    `${ROOT}/api/auth/.well-known/openid-configuration`,
  )
  expect(await json(await request(path))).not.toHaveProperty('shared_client_id')
  await database.db.updateTable('oauth_clients').set({ disabled: false }).where('client_id', '=', 'shared').execute()
  expect(await json(await request(path))).toHaveProperty('shared_client_id', 'shared')
  expect((await info(issued)).status).toBe(200)
})

test('核对两个插件的全部 HTTP 端点，只开放 ADR-0037 的八组路径', async () => {
  const options = authOptions({
    db: database.db,
    secretKey,
    siteUrl: ROOT,
    siteName: 'NextSkin',
    legacyPasswordSalt: () => Promise.resolve(''),
  })
  const allowed = new Set([
    '/oauth2/authorize',
    '/oauth2/consent',
    '/oauth2/token',
    '/oauth2/userinfo',
    '/oauth2/revoke',
    '/oauth2/introspect',
    '/device/code',
  ])
  const reachable = new Set<string>()
  for (const plugin of options.plugins.filter((plugin) =>
    ['oauth-provider', 'device-authorization'].includes(plugin.id),
  )) {
    for (const endpoint of Object.values((plugin as BetterAuthPlugin).endpoints ?? {}) as {
      path: string
      options: { method?: string | string[]; metadata?: { SERVER_ONLY?: boolean } }
    }[]) {
      const methods = [endpoint.options.method ?? 'GET'].flat()
      for (const method of methods) {
        const path = endpoint.path.replace(':identifier', 'example').replace(':client_id', 'shared')
        const response = await request(path, method === 'GET' ? undefined : {}, {}, method)
        // 这个位置由 service.ts 手动提供，和插件的 HTTP 端点分开断言。
        if (path === '/.well-known/openid-configuration') {
          expect(response.status).toBe(200)
          continue
        }
        if (response.status !== 404) reachable.add(endpoint.path)
        if (!allowed.has(endpoint.path)) expect(response.status, `${method} ${endpoint.path}`).toBe(404)
      }
    }
  }
  expect(reachable).toEqual(allowed)
  expect((await request('/.well-known/oauth-authorization-server')).status).toBe(404)
  expect((await request('/device/token', {})).status).toBe(404)
  const devicePlugin = options.plugins.find((plugin) => plugin.id === 'device-authorization')!
  expect(
    (devicePlugin.options as unknown as { grant: { grants: Record<string, unknown> } }).grant.grants[
      DEVICE_CODE_GRANT_TYPE
    ],
  ).toEqual(expect.any(Function))
})

test('授权码放行 Yggdrasil scope，省略 scope 时仍过滤默认的 Yggdrasil scope', async () => {
  const clientId = await importedClient()
  await database.db
    .updateTable('oauth_clients')
    .set({
      grant_types: JSON.stringify(['authorization_code', 'refresh_token']),
      redirect_uris: JSON.stringify(['https://app.example.test/cb']),
    })
    .where('client_id', '=', clientId)
    .execute()
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: 'https://app.example.test/cb',
    code_challenge: randomBytes(32).toString('base64url'),
    code_challenge_method: 'S256',
  })
  const selected = await request(`/oauth2/authorize?${params.toString()}&scope=${encodeURIComponent(SCOPE)}`)
  expect(selected.status).toBe(302)
  const login = new URL(selected.headers.get('location')!, ROOT)
  expect(login.pathname).toBe('/sign-in')
  expect(login.searchParams.get('scope')).toBe(SCOPE)
  const response = await request(`/oauth2/authorize?${params.toString()}`)
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('location')!, ROOT)
  expect(location.pathname).toBe('/sign-in')
  expect(location.search).not.toContain('Yggdrasil')
})

test('发现地址只取实际配置的 https，开发环境为空时才用 requestRoot', async () => {
  expect(await core.auth.openIdConfigurationUrl('http://wrong.example')).toBe(
    `${ROOT}/api/auth/.well-known/openid-configuration`,
  )
  await setting('site.url', 'http://skin.example.test')
  expect(await core.auth.openIdConfigurationUrl(ROOT)).toBeNull()
  await setting('site.url', '')
  expect(await core.auth.openIdConfigurationUrl(ROOT)).toBe(`${ROOT}/api/auth/.well-known/openid-configuration`)
  expect(await core.auth.openIdConfigurationUrl('http://localhost')).toBeNull()
})

async function otherUser() {
  return (
    await core.users.register({
      email: `${randomBytes(8).toString('hex')}@example.test`,
      password: 'correct horse battery staple',
      playerName: 'Alex',
      ip: '127.0.0.1',
      locale: null,
    })
  ).uid
}

test('头像声明用渲染地址，忽略 users.image', async () => {
  const hash = 'a'.repeat(64)
  const now = toIsoTimestamp(new Date())
  await database.db
    .insertInto('texture_files')
    .values({
      hash,
      pixel_hash: hash,
      width: 64,
      height: 64,
      size_bytes: 100,
      ref_count: 1,
      status: 'active',
      status_changed_at: now,
      created_at: now,
    })
    .execute()
  const tid = await insertReturningId(database.db, 'textures', {
    hash,
    name: 'Avatar',
    type: 'steve',
    uploader_id: uid,
    is_public: 0,
    created_at: now,
    updated_at: now,
  })
  await database.db
    .updateTable('users')
    .set({ avatar_texture_id: tid, image: 'https://wrong.example/image' })
    .where('id', '=', uid)
    .execute()
  try {
    const tokens = await issue(`${SCOPE} profile`)
    // 64×64 的皮肤 s = 1，按原分辨率出图
    const picture = `${ROOT}/render/v${RENDERER_VERSION}/head/1/${hash}.png`
    expect(decodeJwt(tokens.id_token)).toHaveProperty('picture', picture)
    expect(await json(await info(tokens))).toHaveProperty('picture', picture)
    const withoutProfile = await issue()
    expect(await json(await info(withoutProfile))).not.toHaveProperty('picture')
  } finally {
    await database.db.updateTable('users').set({ avatar_texture_id: null }).where('id', '=', uid).execute()
    await database.db.deleteFrom('textures').where('id', '=', tid).execute()
    await database.db.deleteFrom('texture_files').where('hash', '=', hash).execute()
  }
})

test.each(['before', 'after'] as const)(
  '签发 %s 的角色转让：声明失败不留令牌，提交后的复核作废新令牌',
  async (when) => {
    const owner = await otherUser()
    const auth = createAuth({
      db: database.db,
      secretKey,
      siteUrl: ROOT,
      siteName: 'NextSkin',
      legacyPasswordSalt: () => Promise.resolve(''),
    })
    await auth.api.getJwks()
    const plugin = auth.options.plugins.find((plugin) => plugin.id === 'device-authorization')!
    const grants = (plugin.options as unknown as { grant: { grants: Record<string, OAuthExtensionGrantHandler> } })
      .grant.grants
    const original = grants[DEVICE_CODE_GRANT_TYPE]!
    grants[DEVICE_CODE_GRANT_TYPE] = (input) =>
      original({
        ...input,
        provider: {
          ...input.provider,
          issueTokens: async (params) => {
            if (when === 'before')
              await database.db.updateTable('players').set({ user_id: owner }).where('id', '=', pid).execute()
            const tokens = await input.provider.issueTokens(params)
            if (when === 'after')
              await database.db.updateTable('players').set({ user_id: owner }).where('id', '=', pid).execute()
            return tokens
          },
        },
      })
    const code = await device()
    await approve(code)
    const response = await auth.handler(
      new Request(`${ROOT}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: code.device_code,
          client_id: 'shared',
        }).toString(),
      }),
    )
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: 'invalid_grant' })
    expect(await database.db.selectFrom('oauth_access_tokens').select('id').execute()).toEqual([])
    expect(await database.db.selectFrom('oauth_refresh_tokens').select('id').execute()).toEqual([])
    expect(await database.db.selectFrom('device_code_selections').selectAll().execute()).toEqual([])
  },
)

test('after 检查失败关闭签发响应，只写固定日志', async () => {
  const auth = createAuth({
    db: database.db,
    secretKey,
    siteUrl: ROOT,
    siteName: 'NextSkin',
    legacyPasswordSalt: () => Promise.resolve(''),
    tokensPerUser: () => Promise.reject(new Error('SECRET_CANARY')),
  })
  const code = await device()
  await approve(code)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const response = await auth.handler(
      new Request(`${ROOT}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: code.device_code,
          client_id: 'shared',
        }).toString(),
      }),
    )
    expect(response.status).toBe(500)
    expect(await json(response)).toMatchObject({ error: 'server_error' })
    expect(warn).toHaveBeenCalledExactlyOnceWith('[auth] oauth_token_check_failed')
  } finally {
    warn.mockRestore()
  }
})

test('冷启动并发请求先共用一次 JWKS 预热，首把密钥能验证并发签发的 ID 令牌', async () => {
  const auth = createAuthService({
    db: database.db,
    secretKey,
    production: false,
    settings: core.settings,
    mail: core.mail,
  })
  const codes = await Promise.all([device(), device(), device()])
  for (const code of codes) await approve(code)
  await database.db.deleteFrom('jwks').execute()
  const responses = await Promise.all(
    codes.map((code) =>
      auth.handle(
        new Request(`${ROOT}/api/auth/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: 'shared',
            grant_type: DEVICE_CODE_GRANT_TYPE,
            device_code: code.device_code,
          }).toString(),
        }),
        ROOT,
        '127.0.0.1',
      ),
    ),
  )
  const jwks = (await (await auth.handle(new Request(`${ROOT}/api/auth/jwks`), ROOT, null)).json()) as JSONWebKeySet
  expect(jwks.keys).toHaveLength(1)
  for (const response of responses) {
    expect(response.status).toBe(200)
    const tokens = (await response.json()) as Tokens
    expect(decodeProtectedHeader(tokens.id_token).kid).toBe(jwks.keys[0]!.kid)
    await jwtVerify(tokens.id_token, await importJWK(jwks.keys[0]!, 'RS256'))
  }
})

test.each(['GET', 'POST'])('公用应用的 %s 授权码请求去错误页 unauthorized_client', async (method) => {
  const params = { client_id: 'shared', scope: SCOPE, response_type: 'code' }
  const response =
    method === 'POST'
      ? await request('/oauth2/authorize', params)
      : await request(`/oauth2/authorize?${new URLSearchParams(params).toString()}`)
  expect(response.status).toBe(302)
  expect(new URL(response.headers.get('location')!, ROOT).searchParams.get('error')).toBe('unauthorized_client')
})

test('userinfo 的 POST access_token 和 Bearer 一样检查封禁、声明和响应头', async () => {
  const tokens = await issue(`${SCOPE} profile`)
  const response = await request('/oauth2/userinfo', { access_token: tokens.access_token })
  expect(response.status).toBe(200)
  expect(await json(response)).toMatchObject({ aud: 'shared', sub: String(uid), selectedProfile: { name: 'Steve' } })
  expect(response.headers.get('cache-control')).toContain('no-store')
  await database.db.updateTable('users').set({ role: 'banned' }).where('id', '=', uid).execute()
  const banned = await request('/oauth2/userinfo', { access_token: tokens.access_token })
  expect(banned.status).toBe(401)
  expect(banned.headers.get('www-authenticate')).toBe(
    'Bearer error="invalid_token", error_description="Invalid access token"',
  )
})

test('另一个客户端撤销访问令牌仍返回 200，但不能删除它的刷新令牌', async () => {
  const tokens = await issue()
  const otherClient = await importedClient()
  expect((await request('/oauth2/revoke', { token: tokens.access_token, client_id: otherClient })).status).toBe(200)
  expect(
    await database.db
      .selectFrom('oauth_access_tokens')
      .select('id')
      .where('token', '=', sha256(tokens.access_token))
      .execute(),
  ).toHaveLength(1)
  expect(
    await database.db
      .selectFrom('oauth_refresh_tokens')
      .select('id')
      .where('token', '=', sha256(tokens.refresh_token))
      .execute(),
  ).toHaveLength(1)
})

test('重复 scope 的合法值不会被最后的空串丢掉', async () => {
  const response = await request('/device/code', `client_id=shared&scope=${encodeURIComponent(SCOPE)}&scope=`)
  expect(response.status).toBe(200)
  const code = (await response.json()) as DeviceCode
  const row = await database.db
    .selectFrom('device_codes')
    .select('scope')
    .where('device_code', '=', code.device_code)
    .executeTakeFirstOrThrow()
  expect(row.scope).toBe(SCOPE)
})

test('POST 内部续跑按 authorizeSettings 读取 query，不被 consent 的 body 遮住', async () => {
  const auth = createAuth({
    db: database.db,
    secretKey,
    siteUrl: ROOT,
    siteName: 'NextSkin',
    legacyPasswordSalt: () => Promise.resolve(''),
  })
  const provider = auth.options.plugins.find((plugin) => plugin.id === 'oauth-provider') as ReturnType<
    typeof oauthProvider
  >
  const input: DispatchContext & { authorizeSettings: { isAuthorize?: boolean } } = {
    context: (await auth.$context) as unknown as DispatchContext['context'],
    method: 'POST',
    body: { accept: true },
    query: { client_id: 'shared', scope: 'openid Yggdrasil.Server.Join' },
    authorizeSettings: {},
  }
  await expect(dispatchAuthEndpoint(provider.endpoints.oauth2Authorize, input)).rejects.toMatchObject({
    status: 'FOUND',
  })
})

test.each(['/device/code', '/oauth2/token', '/oauth2/authorize'])(
  '拒绝 %s 的 resource，包括 Better Auth 隐式接受的 userinfo 资源',
  async (path) => {
    for (const resource of [`${ROOT}/api/auth/oauth2/userinfo`, 'https://resource.example.test']) {
      const form = `client_id=shared&scope=openid&grant_type=${encodeURIComponent(DEVICE_CODE_GRANT_TYPE)}&device_code=unused&resource=${encodeURIComponent(resource)}&resource=`
      const response = await request(path, form)
      expect(response.status).toBe(400)
      expect(await json(response)).toMatchObject({ error: 'invalid_target' })
    }
    if (path === '/oauth2/authorize') {
      const response = await request(
        `/oauth2/authorize?client_id=shared&scope=openid&resource=${encodeURIComponent(`${ROOT}/api/auth/oauth2/userinfo`)}`,
      )
      expect(response.status).toBe(400)
      expect(await json(response)).toMatchObject({ error: 'invalid_target' })
    }
  },
)

test('刷新显式去掉 offline_access 被拒；保留它并去掉 Join 时轮换旧刷新令牌', async () => {
  const tokens = await issue()
  const rejected = await refresh(tokens, { scope: `openid ${SELECT_SCOPE}` })
  expect(rejected.status).toBe(400)
  expect(await json(rejected)).toMatchObject({ error: 'invalid_scope' })
  const response = await refresh(tokens, { scope: `openid offline_access ${SELECT_SCOPE}` })
  expect(response.status).toBe(200)
  const next = (await response.json()) as Tokens
  expect(next.refresh_token).not.toBe(tokens.refresh_token)
  expect(next.scope).not.toContain('Yggdrasil.Server.Join')
  expect((await info(tokens)).status).toBe(401)
  expect((await info(next)).status).toBe(200)
  expect(await json(await refresh(tokens))).toMatchObject({ error: 'invalid_grant' })
})

test.each(['tab', 'bare', 'blank'] as const)('userinfo 的 %s Authorization 写法同样拒绝被封禁用户', async (kind) => {
  const tokens = await issue()
  await database.db.updateTable('users').set({ role: 'banned' }).where('id', '=', uid).execute()
  const authorization = { tab: `Bearer\t${tokens.access_token}`, bare: tokens.access_token, blank: ' ' }[kind]
  // 空白的请求头解析不出令牌，Better Auth 改用请求体里的令牌
  const form = kind === 'blank' ? { access_token: tokens.access_token } : undefined
  const response = await request('/oauth2/userinfo', form, { authorization })
  expect(response.status).toBe(401)
  expect(await json(response)).toMatchObject({ error: 'invalid_token' })
})

test.each(['bearer', 'whitespace'] as const)('revoke 规范化 %s token 后删除配对刷新令牌', async (kind) => {
  const tokens = await issue()
  const token = kind === 'bearer' ? `Bearer ${tokens.access_token}` : `  ${tokens.access_token}  `
  expect((await request('/oauth2/revoke', { token, client_id: 'shared' })).status).toBe(200)
  expect(await database.db.selectFrom('oauth_access_tokens').select('id').execute()).toEqual([])
  expect(await database.db.selectFrom('oauth_refresh_tokens').select('id').execute()).toEqual([])
  expect(await json(await refresh(tokens))).toMatchObject({ error: 'invalid_grant' })
})

test.each(['/device/code', '/device/code/', '/oauth2/token', '/oauth2/token/', '/oauth2/introspect', '/oauth2/revoke'])(
  '%s 拒绝主类型与 form 参数不一致的 Content-Type',
  async (path) => {
    const response = await request(path, JSON.stringify({ client_id: 'shared' }), {
      'content-type': 'application/json; x=application/x-www-form-urlencoded',
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: 'invalid_request' })
    expect(await database.db.selectFrom('device_codes').select('id').execute()).toEqual([])
  },
)

test.each([
  [DEVICE_CODE_GRANT_TYPE, 'password'],
  [DEVICE_CODE_GRANT_TYPE, 'authorization'],
  ['refresh_token', 'password'],
  ['refresh_token', 'authorization'],
] as const)('快照之后签发之前吊销：%s / %s，撤回实际签发的令牌对', async (grant, revocation) => {
  const browser = new Browser(core, ROOT)
  expect(
    (
      await browser.request('/api/auth/sign-in/email', {
        email: 'connect@example.test',
        password: 'correct horse battery staple',
      })
    ).status,
  ).toBe(200)
  const form: Record<string, string> = { grant_type: grant, client_id: 'shared' }
  if (grant === 'refresh_token') form.refresh_token = (await issue('openid offline_access')).refresh_token
  else {
    const code = await device('openid offline_access')
    await approve(code, false)
    form.device_code = code.device_code
  }
  const auth = createAuth({
    db: database.db,
    secretKey,
    siteUrl: ROOT,
    siteName: 'NextSkin',
    legacyPasswordSalt: () => Promise.resolve(''),
  })
  await auth.api.getJwks()
  const context = await auth.$context
  const create = context.adapter.create.bind(context.adapter)
  let revoked = false
  const inserted: string[] = []
  const spy = vi.spyOn(context.adapter, 'create').mockImplementation(async (input) => {
    if (input.model === 'oauthRefreshToken' && !revoked) {
      revoked = true
      if (revocation === 'password') {
        // 走 core.ts 的 onPasswordChanged，包含真实密码写入和独立提交的凭据吊销。
        const response = await browser.request('/api/auth/change-password', {
          currentPassword: 'correct horse battery staple',
          newPassword: 'changed correct horse battery staple',
        })
        expect(response.status).toBe(200)
      } else {
        const client = await database.db
          .selectFrom('oauth_clients')
          .select('id')
          .where('client_id', '=', 'shared')
          .executeTakeFirstOrThrow()
        await core.oauth.revokeAuthorization(uid, client.id)
      }
    }
    const result = await create(input)
    if (input.model === 'oauthRefreshToken' || input.model === 'oauthAccessToken') inserted.push(input.model)
    return result
  })
  try {
    const response = await auth.handler(
      new Request(`${ROOT}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      }),
    )
    expect(revoked).toBe(true)
    expect(inserted).toEqual(['oauthRefreshToken', 'oauthAccessToken'])
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: 'invalid_grant' })
    expect(await database.db.selectFrom('oauth_access_tokens').select('id').execute()).toEqual([])
    expect(await database.db.selectFrom('oauth_refresh_tokens').select('id').execute()).toEqual([])
    expect(
      (await database.db.selectFrom('users').select('oauth_version').where('id', '=', uid).executeTakeFirstOrThrow())
        .oauth_version,
    ).toBe(1)
  } finally {
    spy.mockRestore()
  }
})

test('after 复核事务抛错时返回 server_error，不泄露令牌或异常内容', async () => {
  let failure: MockInstance<typeof database.db.transaction> | undefined
  const auth = createAuth({
    db: database.db,
    secretKey,
    siteUrl: ROOT,
    siteName: 'NextSkin',
    legacyPasswordSalt: () => Promise.resolve(''),
    tokensPerUser: () => {
      failure = vi.spyOn(database.db, 'transaction').mockImplementationOnce(() => {
        throw new Error('SECRET_CANARY')
      })
      return Promise.resolve(10)
    },
  })
  await auth.api.getJwks()
  const code = await device('openid offline_access')
  await approve(code, false)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const response = await auth.handler(
      new Request(`${ROOT}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: code.device_code,
          client_id: 'shared',
        }).toString(),
      }),
    )
    expect(response.status).toBe(500)
    expect(await json(response)).toEqual({ error: 'server_error', error_description: 'Token check failed' })
    expect(warn).toHaveBeenCalledExactlyOnceWith('[auth] oauth_token_check_failed')
    expect(failure).toHaveBeenCalledOnce()
  } finally {
    failure?.mockRestore()
    warn.mockRestore()
  }
})

// 只收表单的端点在钩子之前就按媒体类型返回 415
test.each([
  ['/device/code', 400],
  ['/oauth2/consent', 400],
  ['/oauth2/token', 415],
  ['/oauth2/revoke', 415],
  ['/oauth2/authorize', 415],
] as const)('%s 拒绝不是对象的 JSON 请求体，不把请求体写进日志', async (path, status) => {
  const marker = `marker-${randomBytes(8).toString('hex')}`
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  )
  try {
    for (const body of [JSON.stringify(marker), JSON.stringify([marker]), 'null']) {
      const response = await request(path, body, { 'content-type': 'application/json' })
      expect(response.status).toBe(status)
      expect(await response.text()).not.toContain(marker)
    }
    const logged = spies.flatMap((spy) => spy.mock.calls.flat().map((arg) => inspect(arg))).join('\n')
    expect(logged).not.toContain(marker)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
})

test('grant_type 两端带空白时同样检查 scope、记快照，刷新后旧访问令牌失效', async () => {
  const tokens = await issue()
  const rejected = await refresh(tokens, { grant_type: ' refresh_token ', scope: `openid ${SELECT_SCOPE}` })
  expect(rejected.status).toBe(400)
  expect(await json(rejected)).toMatchObject({ error: 'invalid_scope' })
  const response = await refresh(tokens, { grant_type: ' refresh_token ' })
  expect(response.status).toBe(200)
  const next = (await response.json()) as Tokens
  expect((await info(tokens)).status).toBe(401)
  expect((await info(next)).status).toBe(200)
  const code = await device()
  await approve(code, true)
  const polled = await request('/oauth2/token', {
    grant_type: ` ${DEVICE_CODE_GRANT_TYPE} `,
    device_code: code.device_code,
    client_id: 'shared',
  })
  expect(polled.status).toBe(200)
})
