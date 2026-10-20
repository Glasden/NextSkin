import { randomInt } from 'node:crypto'
import { countRows, readAuthBoolean, readAuthDate, toIsoTimestamp, writeAuthDate } from '@nextskin/db'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { sha256 } from '../auth/auth.ts'
import { Browser, ROOT } from '../auth/security.test-helper.ts'
import { pauseNextCommit } from '../commit-pause.test-helper.ts'
import { markSiteInitialized } from '../setup/initialized.test-helper.ts'
import { oauthFixture, seedOAuth } from './oauth.test-helper.ts'
import { DEVICE_CODE_GRANT_TYPE, readScopes, SHARED_CLIENT_SCOPES } from './scopes.ts'
import type { OAuthClientType } from './clients.ts'

vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>()
  return { ...crypto, randomInt: vi.fn(crypto.randomInt) }
})
let env: Awaited<ReturnType<typeof oauthFixture>>
let uid: number, other: number, pid: number
beforeAll(async () => {
  env = await oauthFixture()
})
afterAll(async () => env?.cleanup())
beforeEach(async () => {
  vi.mocked(randomInt).mockImplementation(
    (await vi.importActual<typeof import('node:crypto')>('node:crypto')).randomInt,
  )
  await env.clear()
  uid = await env.user('owner')
  other = await env.user('other')
  pid = await env.player(uid, 'Steve')
})
const input = (type: OAuthClientType = 'web') => ({
  name: ' App ',
  type,
  redirectUris: type === 'web' ? ['https://Example.com:443/a%2fb'] : [],
})
const create = (type: OAuthClientType = 'web') => env.core.oauth.createClient({ uid }, input(type))
const row = (id: number) =>
  env.db.selectFrom('oauth_clients').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
async function setting(key: string, value: unknown) {
  await env.db
    .insertInto('settings')
    .values({ namespace: 'core', key, value: JSON.stringify(value), updated_at: toIsoTimestamp(env.now()) })
    .execute()
}

test.each(['web', 'native'] as const)('创建 %s 逐项写列，敏感值不出现在视图和审计', async (type) => {
  const { client, clientSecret } = await create(type)
  const stored = await row(client.id)
  expect(client).toEqual({
    id: stored.id,
    clientId: stored.client_id,
    name: 'App',
    type,
    redirectUris: input(type).redirectUris,
    deviceCode: type === 'native',
    disabled: false,
    createdAt: toIsoTimestamp(env.now()),
    authorizedUsers: 0,
  })
  expect(client.clientId).toMatch(/^[a-z]{32}$/)
  expect(stored.client_id).toBe(client.clientId)
  expect(stored.user_id).toBe(uid)
  expect(stored.name).toBe('App')
  expect(readAuthBoolean(stored.disabled!)).toBe(false)
  expect(readAuthBoolean(stored.require_pkce!)).toBe(type === 'native')
  expect(stored.application_type).toBe(type)
  expect(stored.token_endpoint_auth_method).toBe(type === 'web' ? 'client_secret_basic' : 'none')
  expect(readAuthDate(stored.created_at)).toBe(toIsoTimestamp(env.now()))
  expect(readAuthDate(stored.updated_at)).toBe(toIsoTimestamp(env.now()))
  expect(readScopes(stored.redirect_uris)).toEqual(input(type).redirectUris)
  expect(readScopes(stored.grant_types)).toEqual(
    type === 'web' ? ['authorization_code', 'refresh_token'] : [DEVICE_CODE_GRANT_TYPE, 'refresh_token'],
  )
  expect(type === 'web' ? readScopes(stored.response_types) : stored.response_types).toEqual(
    type === 'web' ? ['code'] : null,
  )
  expect(type === 'web' ? stored.scopes : readScopes(stored.scopes)).toEqual(
    type === 'web' ? null : SHARED_CLIENT_SCOPES,
  )
  if (type === 'web') {
    expect(clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(stored.client_secret).toBe(sha256(clientSecret!))
    expect(stored.client_secret).not.toBe(clientSecret)
  } else expect(stored.client_secret).toBeNull()
  const written = new Set([
    'id',
    'client_id',
    'name',
    'user_id',
    'disabled',
    'redirect_uris',
    'created_at',
    'updated_at',
    'client_secret',
    'token_endpoint_auth_method',
    'require_pkce',
    'application_type',
    'grant_types',
    'response_types',
    'scopes',
  ])
  for (const [key, value] of Object.entries(stored)) if (!written.has(key)) expect(value, key).toBeNull()
  expect(await countRows(env.db.selectFrom('audit_logs'))).toBe(0)
})

test('启动器有回调地址时才加授权码；地址去空白、去空串、去重但不序列化 URL', async () => {
  const uri = 'HTTPS://Example.com:443/a%2fb'
  const { client } = await env.core.oauth.createClient(
    { uid },
    { name: '😀'.repeat(255), type: 'native', redirectUris: [' ', ` ${uri} `, uri, 'com.example.app:/cb', ''] },
  )
  expect(client.redirectUris).toEqual([uri, 'com.example.app:/cb'])
  expect(readScopes((await row(client.id)).grant_types)).toEqual([
    DEVICE_CODE_GRANT_TYPE,
    'refresh_token',
    'authorization_code',
  ])
  expect(readScopes((await row(client.id)).response_types)).toEqual(['code'])
})

test.each([
  '',
  '  ',
  'a'.repeat(256),
  '😀'.repeat(256),
  'a\nb',
  'a\tb',
  'a\u007fb',
  'a\u0085b',
  ...['\u061c', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069'].map((c) => `a${c}b`),
])('名称拒绝长度或控制字符 %j', async (name) => {
  await expect(env.core.oauth.createClient({ uid }, { ...input(), name })).rejects.toMatchObject({
    code: 'oauth_client_name_invalid',
    params: { min: 1, max: 255 },
  })
})

test.each([
  [{ name: 'a\0b' }, 'invalid_request'],
  [{ redirectUris: ['https://example.com/\0'] }, 'invalid_request'],
  [{ redirectUris: [] }, 'oauth_redirect_uri_required'],
  [{ redirectUris: ['http://localhost/cb'] }, 'oauth_redirect_uri_invalid'],
  [{ redirectUris: ['https://example.com/#'] }, 'oauth_redirect_uri_invalid'],
  [{ redirectUris: Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`) }, 'oauth_redirect_uris_too_many'],
  [{ redirectUris: ['https://example.com/' + 'a'.repeat(2049)] }, 'oauth_redirect_uri_too_long'],
] as const)('创建校验 %j', async (patch, code) => {
  await expect(
    env.core.oauth.createClient(
      { uid },
      { ...input(), ...patch, redirectUris: 'redirectUris' in patch ? [...patch.redirectUris] : input().redirectUris },
    ),
  ).rejects.toMatchObject({ code })
})

test('回调地址 20 条、2048 字符的边界接受，重复地址不占条数', async () => {
  const uri = 'https://example.com/' + 'a'.repeat(2048 - 'https://example.com/'.length)
  expect(
    (await env.core.oauth.createClient({ uid }, { ...input(), redirectUris: Array.from({ length: 100 }, () => uri) }))
      .client.redirectUris,
  ).toEqual([uri])
  const uris = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`)
  expect((await env.core.oauth.createClient({ uid }, { ...input(), redirectUris: uris })).client.redirectUris).toEqual(
    uris,
  )
})

test('修改只校验新增地址，保留导入配置；空 grant_types 按授权码读并显式写刷新', async () => {
  const { client } = await create()
  const old = 'http://example.com/cb'
  await env.db
    .updateTable('oauth_clients')
    .set({ redirect_uris: JSON.stringify([old]), grant_types: null, application_type: null })
    .where('id', '=', client.id)
    .execute()
  expect(await env.core.oauth.updateClient({ uid }, client.id, { name: 'Renamed' })).toMatchObject({
    name: 'Renamed',
    redirectUris: [old],
  })
  expect(
    await env.core.oauth.updateClient({ uid }, client.id, { redirectUris: [old, 'https://example.com/new'] }),
  ).toMatchObject({ redirectUris: [old, 'https://example.com/new'] })
  const stored = await row(client.id)
  expect(readScopes(stored.grant_types)).toEqual(['authorization_code', 'refresh_token'])
  expect(stored.application_type).toBeNull()
  await expect(
    env.core.oauth.updateClient({ uid }, client.id, { redirectUris: [old, 'http://example.com/new'] }),
  ).rejects.toMatchObject({ code: 'oauth_redirect_uri_invalid' })
  await expect(env.core.oauth.updateClient({ uid }, client.id, { redirectUris: [] })).rejects.toMatchObject({
    code: 'oauth_redirect_uri_required',
  })
  await expect(env.core.oauth.updateClient({ uid }, client.id, { name: '\u202efoo' })).rejects.toMatchObject({
    code: 'oauth_client_name_invalid',
  })
})

test('授权码随地址增减，其余授权方式和配置不动；Passport 公共客户端不会多出设备码', async () => {
  const { client } = await create('native')
  const initial = await row(client.id)
  await env.core.oauth.updateClient({ uid }, client.id, { redirectUris: ['com.example.app:/cb'] })
  expect(readScopes((await row(client.id)).grant_types)).toEqual([
    DEVICE_CODE_GRANT_TYPE,
    'refresh_token',
    'authorization_code',
  ])
  await env.core.oauth.updateClient({ uid }, client.id, { redirectUris: [] })
  expect(readScopes((await row(client.id)).grant_types)).toEqual([DEVICE_CODE_GRANT_TYPE, 'refresh_token'])
  expect((await row(client.id)).response_types).toBeNull()
  for (const key of ['scopes', 'application_type', 'require_pkce', 'token_endpoint_auth_method'] as const)
    expect((await row(client.id))[key]).toEqual(initial[key])
  await env.db
    .updateTable('oauth_clients')
    .set({ grant_types: JSON.stringify(['authorization_code', 'refresh_token']), application_type: null })
    .where('id', '=', client.id)
    .execute()
  await env.core.oauth.updateClient({ uid }, client.id, { redirectUris: ['http://localhost/cb'] })
  expect(readScopes((await row(client.id)).grant_types)).toEqual(['authorization_code', 'refresh_token'])
  expect((await row(client.id)).application_type).toBeNull()
  await expect(env.core.oauth.updateClient({ uid }, client.id, { redirectUris: [] })).rejects.toMatchObject({
    code: 'oauth_redirect_uri_required',
  })
})

test('原来不能刷新的应用改了也不能刷新；隐含刷新的去掉授权码之后显式登记', async () => {
  const { client } = await create('native')
  await env.db
    .updateTable('oauth_clients')
    .set({ grant_types: JSON.stringify([DEVICE_CODE_GRANT_TYPE]) })
    .where('id', '=', client.id)
    .execute()
  await env.core.oauth.updateClient({ uid }, client.id, { name: 'Renamed', redirectUris: [] })
  expect(readScopes((await row(client.id)).grant_types)).toEqual([DEVICE_CODE_GRANT_TYPE])
  await env.db
    .updateTable('oauth_clients')
    .set({
      grant_types: JSON.stringify([DEVICE_CODE_GRANT_TYPE, 'authorization_code']),
      redirect_uris: JSON.stringify(['com.example.app:/cb']),
    })
    .where('id', '=', client.id)
    .execute()
  await env.core.oauth.updateClient({ uid }, client.id, { redirectUris: [] })
  expect(readScopes((await row(client.id)).grant_types)).toEqual([DEVICE_CODE_GRANT_TYPE, 'refresh_token'])
})

test('重置只换哈希和时间，保留令牌和同意；公共客户端被拒；停用也能改、重置、删', async () => {
  const { client, clientSecret } = await create()
  await seedOAuth(env.db, uid, pid, client.clientId)
  const before = await row(client.id)
  env.advance(1000)
  await env.db.updateTable('oauth_clients').set({ disabled: true }).where('id', '=', client.id).execute()
  const reset = await env.core.oauth.resetClientSecret({ uid }, client.id)
  expect(reset.clientSecret).not.toBe(clientSecret)
  expect((await row(client.id)).client_secret).toBe(sha256(reset.clientSecret))
  expect(readAuthDate((await row(client.id)).updated_at)).not.toBe(readAuthDate(before.updated_at))
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_consents'] as const)
    expect(await countRows(env.db.selectFrom(table).where('client_id', '=', client.clientId))).toBe(1)
  await env.core.oauth.updateClient({ uid }, client.id, {
    name: 'Still disabled',
    redirectUris: ['https://example.com/new'],
  })
  expect(readAuthBoolean((await row(client.id)).disabled!)).toBe(true)
  const native = await create('native')
  await expect(env.core.oauth.resetClientSecret({ uid }, native.client.id)).rejects.toMatchObject({
    code: 'oauth_client_public',
  })
  await env.core.oauth.deleteClient({ uid }, client.id)
})

test('删除清理任何状态的设备码、选择和所有授权，其他应用/用户的其他设备码保留', async () => {
  const { client } = await create('native')
  const otherPid = await env.player(other, 'Alex')
  await seedOAuth(env.db, uid, pid, client.clientId)
  await seedOAuth(env.db, other, otherPid, client.clientId)
  await seedOAuth(env.db, other, otherPid)
  for (const status of ['denied', 'expired']) {
    const code = await env.device({ status, clientId: client.clientId, code: status })
    await env.db
      .insertInto('device_code_selections')
      .values({ device_code: code.device_code, user_id: uid, player_id: pid, created_at: toIsoTimestamp(env.now()) })
      .execute()
  }
  await env.core.oauth.deleteClient({ uid }, client.id)
  expect(await env.db.selectFrom('oauth_clients').select('id').where('id', '=', client.id).execute()).toEqual([])
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_consents'] as const)
    expect(await env.db.selectFrom(table).select('client_id').execute()).toEqual([{ client_id: 'shared' }])
  expect(await env.db.selectFrom('device_codes').select('client_id').execute()).toEqual([
    { client_id: 'shared' },
    { client_id: 'shared' },
  ])
  expect(await countRows(env.db.selectFrom('device_code_selections'))).toBe(2)
})

test('删除等进行中的设备码批准提交后再清理，不留下它写入的角色选择', async () => {
  const { client } = await create('native')
  const otherPid = await env.player(other, 'Alex')
  const code = await env.device({ uid: other, clientId: client.clientId })
  const pause = pauseNextCommit(env.db)
  let approving: Promise<unknown> | undefined, deleting: Promise<unknown> | undefined
  try {
    approving = env.core.oauth.approveDevice(other, { userCode: code.user_code, pid: otherPid })
    await pause.entered
    deleting = env.core.oauth.deleteClient({ uid }, client.id)
    await pause.contended
    // 给删除时间走到等锁的地方：不先锁设备码的话，它在 PostgreSQL 上已经删过（还看不到的）选择
    await new Promise((resolve) => setTimeout(resolve, 200))
    pause.resume()
    await Promise.all([approving, deleting])
  } finally {
    pause.resume()
    await Promise.allSettled([approving, deleting])
    pause.restore()
  }
  expect(await countRows(env.db.selectFrom('device_codes').where('client_id', '=', client.clientId))).toBe(0)
  expect(await countRows(env.db.selectFrom('device_code_selections'))).toBe(0)
})

const writes = ['create', 'update', 'reset', 'delete'] as const
async function write(method: (typeof writes)[number], id: number, actor = uid) {
  const user = { uid: actor }
  if (method === 'create') return env.core.oauth.createClient(user, input())
  if (method === 'update') return env.core.oauth.updateClient(user, id, { name: 'Updated' })
  if (method === 'reset') return env.core.oauth.resetClientSecret(user, id)
  return env.core.oauth.deleteClient(user, id)
}
test.each(writes)('%s：封禁和未验证邮箱拒绝写，列表仍能读', async (method) => {
  const { client } = await create()
  await env.db.updateTable('users').set({ role: 'banned' }).where('id', '=', uid).execute()
  await expect(write(method, client.id)).rejects.toMatchObject({ code: 'user_banned' })
  expect(await env.core.oauth.listClients(uid)).toHaveLength(1)
  await env.db.updateTable('users').set({ role: 'user', email_verified: false }).where('id', '=', uid).execute()
  await setting('auth.requireEmailVerification', true)
  await expect(write(method, client.id)).rejects.toMatchObject({ code: 'email_not_verified' })
  expect(await env.core.oauth.listClients(uid)).toHaveLength(1)
})
test.each(['update', 'reset', 'delete'] as const)('%s：别人的和不存在的应用都返回 404', async (method) => {
  const { client } = await create()
  await expect(write(method, client.id, other)).rejects.toMatchObject({ code: 'oauth_client_not_found' })
  await expect(write(method, 2147483647)).rejects.toMatchObject({ code: 'oauth_client_not_found' })
})

test('列表只含自己的，按 id 降序；已授权用户按同意和有效令牌去重，过期、吊销不算', async () => {
  const first = await create()
  const second = await create()
  await seedOAuth(env.db, uid, pid, first.client.clientId)
  await seedOAuth(env.db, other, null, first.client.clientId)
  await env.db.deleteFrom('oauth_consents').where('user_id', '=', other).execute()
  const at = writeAuthDate(env.db, toIsoTimestamp(env.now()))
  await env.db.updateTable('oauth_access_tokens').set({ expires_at: at }).where('user_id', '=', other).execute()
  await env.db.updateTable('oauth_refresh_tokens').set({ revoked: at }).where('user_id', '=', other).execute()
  expect((await env.core.oauth.listClients(uid)).map((c) => [c.id, c.authorizedUsers])).toEqual([
    [second.client.id, 0],
    [first.client.id, 1],
  ])
  await env.db.updateTable('oauth_refresh_tokens').set({ revoked: null }).where('user_id', '=', other).execute()
  expect((await env.core.oauth.listClients(uid))[1]!.authorizedUsers).toBe(2)
  await env.db.deleteFrom('oauth_consents').execute()
  await env.db.updateTable('oauth_access_tokens').set({ revoked: at }).execute()
  await env.db.updateTable('oauth_refresh_tokens').set({ expires_at: at }).execute()
  expect((await env.core.oauth.listClients(uid))[1]!.authorizedUsers).toBe(0)
  expect(await env.core.oauth.listClients(other)).toEqual([])
})

test('client_id 冲突后重做事务，第三次成功；三次仍冲突则回滚且不留下应用', async () => {
  vi.mocked(randomInt).mockImplementation(() => 0)
  await create()
  let calls = 0
  vi.mocked(randomInt).mockImplementation(() => (calls++ < 64 ? 0 : 1))
  expect((await create()).client.clientId).toBe('b'.repeat(32))
  expect(calls).toBe(96)
  vi.mocked(randomInt).mockImplementation(() => 0)
  const count = await countRows(env.db.selectFrom('oauth_clients'))
  const beforeCalls = vi.mocked(randomInt).mock.calls.length
  await expect(create()).rejects.toBeDefined()
  expect(await countRows(env.db.selectFrom('oauth_clients'))).toBe(count)
  expect(vi.mocked(randomInt).mock.calls.length - beforeCalls).toBe(96)
})

// 实际经过 Better Auth handler；不用修改认证配置或钩子，证明登记列能让两种流程工作。
test('新建网站用 Basic、不带 PKCE 换授权码；新建启动器走设备码换令牌', async () => {
  env.advance(Date.now() - env.now().getTime())
  await markSiteInitialized(env.db)
  const password = 'correct horse battery staple'
  await env.core.admin.setPasswordAsSystem(String(uid), { password })
  const browser = new Browser(env.core)
  expect((await browser.request('/api/auth/sign-in/email', { email: 'owner@example.test', password })).status).toBe(200)
  const web = await create()
  const callback = web.client.redirectUris[0]!
  const query = new URLSearchParams({
    client_id: web.client.clientId,
    response_type: 'code',
    redirect_uri: callback,
    scope: 'openid profile',
    state: 'clients-test',
  })
  const start = await browser.request(`/api/auth/oauth2/authorize?${query.toString()}`)
  expect(start.status).toBe(302)
  const consent = new URL(start.headers.get('location')!, ROOT)
  expect(consent.pathname).toBe('/oauth/consent')
  const accepted = await browser.request('/api/auth/oauth2/consent', {
    accept: true,
    oauth_query: consent.search.slice(1),
  })
  expect(accepted.status).toBe(200)
  const location = new URL(((await accepted.json()) as { url: string }).url, ROOT)
  expect(location.searchParams.has('code')).toBe(true)
  const tokenRequest = (form: Record<string, string>, authorization?: string) =>
    env.core.auth.handle(
      new Request('http://127.0.0.1:3000/api/auth/oauth2/token', {
        method: 'POST',
        headers: {
          origin: ROOT,
          'content-type': 'application/x-www-form-urlencoded',
          ...(authorization ? { authorization } : {}),
        },
        body: new URLSearchParams(form).toString(),
      }),
      ROOT,
      '127.0.0.1',
    )
  const tokens = await tokenRequest(
    { grant_type: 'authorization_code', code: location.searchParams.get('code')!, redirect_uri: callback },
    `Basic ${Buffer.from(`${web.client.clientId}:${web.clientSecret}`).toString('base64')}`,
  )
  expect(tokens.status).toBe(200)
  const webTokens = (await tokens.json()) as Record<string, unknown>
  expect(webTokens.access_token).toBeTypeOf('string')
  expect(webTokens.id_token).toBeTypeOf('string')
  const native = await create('native')
  const codeResponse = await browser.request('/api/auth/device/code', {
    client_id: native.client.clientId,
    scope: 'openid offline_access',
  })
  expect(codeResponse.status).toBe(200)
  const code = (await codeResponse.json()) as { user_code: string; device_code: string }
  await env.core.oauth.openDevice(uid, code.user_code)
  await env.core.oauth.approveDevice(uid, { userCode: code.user_code, pid: null })
  await env.db
    .updateTable('device_codes')
    .set({ last_polled_at: writeAuthDate(env.db, toIsoTimestamp(new Date(Date.now() - 6000))) })
    .where('device_code', '=', code.device_code)
    .execute()
  const nativeTokens = await tokenRequest({
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: code.device_code,
    client_id: native.client.clientId,
  })
  expect(nativeTokens.status).toBe(200)
  const issued = (await nativeTokens.json()) as Record<string, unknown>
  for (const key of ['access_token', 'refresh_token', 'id_token']) expect(issued[key]).toBeTypeOf('string')
})
