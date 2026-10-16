/**
 * S1 端到端场景：在真实的 Better Auth 1.7.10 上跑完 Yggdrasil Connect 需要的全部流程。
 * 后半部分是独立审核发现的问题的回归用例（标注"回归"）。
 * 用法：DB=sqlite|postgres|mysql npx tsx src/scenario.ts
 */
import { DEVICE_CODE_GRANT_TYPE } from '@better-auth/oauth-provider'
import bcrypt from 'bcryptjs'
import { getMigrations } from 'better-auth/db/migration'
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { BASE_URL, createAuth, type ClientRegistry } from './auth'
import { createCoreTables, createDb, dropAll, type DialectName } from './db'
import { OAUTH_SCOPES, PROFILE_HEADER, SCOPE, verifyJoinToken } from './yggdrasil-connect'

const dialect = (process.env.DB ?? 'sqlite') as DialectName
const db = createDb(dialect)
await dropAll(db, dialect)
await createCoreTables(db, dialect)

const clients: ClientRegistry = { sharedClientId: '', publicClientIds: new Set() }
const auth = createAuth(db, dialect, clients)
await (await getMigrations(auth.options)).runMigrations()

// ---------------------------------------------------------------- 工具

const results: { name: string; ok: boolean; detail?: string }[] = []
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

interface RequestInit {
  method?: string
  json?: unknown
  form?: Record<string, string>
  bearer?: string
  headers?: Record<string, string>
}

class Browser {
  private jar = new Map<string, string>()
  headers() {
    return new Headers({ origin: BASE_URL, cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') })
  }
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers({ origin: BASE_URL, ...init.headers })
    if (this.jar.size) headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '))
    if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`)
    let body: string | undefined
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(init.json)
    } else if (init.form) {
      headers.set('content-type', 'application/x-www-form-urlencoded')
      body = new URLSearchParams(init.form).toString()
    }
    const method = init.method ?? (body ? 'POST' : 'GET')
    const response = await auth.handler(new Request(new URL(path, BASE_URL), { method, headers, body, redirect: 'manual' }))
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!
      const index = pair.indexOf('=')
      const [key, value] = [pair.slice(0, index), pair.slice(index + 1)]
      if (!value || /max-age=0/i.test(cookie)) this.jar.delete(key)
      else this.jar.set(key, value)
    }
    return response
  }
}

/** Better Auth 对 fetch 请求有时返回 302，有时返回 { redirect, url }，统一取跳转目标。 */
async function redirectTarget(response: Response): Promise<URL> {
  const location = response.headers.get('location')
  if (location) return new URL(location, BASE_URL)
  const text = await response.text()
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`expected redirect, got ${response.status}: ${text.slice(0, 300)}`)
  }
  if (typeof data?.url === 'string') return new URL(data.url, BASE_URL)
  throw new Error(`expected redirect, got ${response.status}: ${text.slice(0, 300)}`)
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function jwks() {
  const response = await auth.handler(new Request(`${BASE_URL}/api/auth/jwks`))
  return createLocalJWKSet(await response.json())
}

async function token(form: Record<string, string>) {
  const response = await new Browser().request('/api/auth/oauth2/token', { form })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

const uuid = () => randomBytes(16).toString('hex')
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- 数据准备

const steve = { email: 'steve@example.com', password: 'correct horse battery' }
const legacy = { email: 'legacy@example.com', password: 'php-era-password' }
const other = { email: 'other@example.com', password: 'another password' }

const signUp = async (u: { email: string; password: string }, name: string) =>
  (await auth.api.signUpEmail({ body: { ...u, name } })).user

const userSteve = await signUp(steve, 'Steve')
const userLegacy = await signUp(legacy, 'Legacy')
const userOther = await signUp(other, 'Other')

// 把 legacy 用户的密码改成 PHP password_hash 风格的 bcrypt（$2y$ 前缀）
const phpHash = (await bcrypt.hash(legacy.password, 10)).replace(/^\$2[ab]\$/, '$2y$')
await db.updateTable('account').set({ password: phpHash }).where('userId', '=', Number(userLegacy.id)).execute()

const insertPlayer = async (uid: number, name: string) => {
  await db.insertInto('players').values({ uid, name, uuid: uuid() }).execute()
  return (await db.selectFrom('players').selectAll().where('name', '=', name).executeTakeFirstOrThrow()) as {
    pid: number
    uuid: string
    name: string
  }
}
const pSteve = await insertPlayer(Number(userSteve.id), 'Steve')
const pAlex = await insertPlayer(Number(userSteve.id), 'Alex')
const pOther = await insertPlayer(Number(userOther.id), 'Herobrine')
const profile = (p: { uuid: string; name: string }) => ({ id: p.uuid, name: p.name })

const scope = OAUTH_SCOPES.join(' ')
// 管理接口要求有登录会话（客户端归属于创建者）；真实系统里由站点管理员在后台创建
const admin = new Browser()
await admin.request('/api/auth/sign-in/email', { json: other })
const launcher = await auth.api.adminCreateOAuthClient({
  headers: admin.headers(),
  body: {
    client_name: 'Example Launcher',
    application_type: 'native',
    redirect_uris: ['http://127.0.0.1:8765/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'client_secret_post',
    scope,
  },
})
const shared = await auth.api.adminCreateOAuthClient({
  headers: admin.headers(),
  body: {
    client_name: 'Shared Launcher Client',
    application_type: 'native',
    redirect_uris: ['http://127.0.0.1/callback'],
    grant_types: [DEVICE_CODE_GRANT_TYPE, 'authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
    scope,
  },
})
clients.sharedClientId = shared.client_id
clients.publicClientIds.add(shared.client_id)
const LAUNCHER_URI = 'http://127.0.0.1:8765/callback'
const SHARED_URI = 'http://127.0.0.1/callback'
const FULL = `openid offline_access ${SCOPE.select} ${SCOPE.join}`

// ---------------------------------------------------------------- 授权码流工具

type Client = { client_id: string; client_secret?: string | undefined | null }

/** 发起授权请求，返回第一个跳转目标。 */
async function startAuthorize(
  browser: Browser,
  client: Client,
  redirectUri: string,
  requestedScope: string,
  options: { method?: 'GET' | 'POST'; extra?: Record<string, string> } = {},
) {
  const proof = pkce()
  const state = randomBytes(8).toString('hex')
  const params = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope: requestedScope,
    state,
    code_challenge: proof.challenge,
    code_challenge_method: 'S256',
    ...options.extra,
  }
  const response =
    options.method === 'POST'
      ? await browser.request('/api/auth/oauth2/authorize', { form: params })
      : await browser.request(`/api/auth/oauth2/authorize?${new URLSearchParams(params)}`)
  return { response, proof, state, client, redirectUri }
}

/** 在同意页上提交：带上所选角色。 */
function submitConsent(browser: Browser, consentPage: URL, pid: number | null, acceptedScope?: string) {
  return browser.request('/api/auth/oauth2/consent', {
    json: { accept: true, oauth_query: consentPage.search.slice(1), ...(acceptedScope ? { scope: acceptedScope } : {}) },
    headers: pid === null ? {} : { [PROFILE_HEADER]: String(pid) },
  })
}

async function exchangeCode(flow: Awaited<ReturnType<typeof startAuthorize>>, callback: URL) {
  assert.equal(callback.searchParams.get('state'), flow.state)
  const code = callback.searchParams.get('code')
  assert.ok(code, `no code: ${callback.href}`)
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.client.client_id,
    code_verifier: flow.proof.verifier,
  }
  if (flow.client.client_secret) form.client_secret = flow.client.client_secret
  const result = await token(form)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body
}

/** 完整走一次授权码流；返回令牌和经过的页面。 */
async function authorizationCodeFlow(browser: Browser, client: Client, redirectUri: string, requestedScope: string, pid: number | null) {
  const flow = await startAuthorize(browser, client, redirectUri, requestedScope)
  const steps: string[] = []
  let target = await redirectTarget(flow.response)
  if (target.pathname === '/oauth/consent') {
    steps.push(target.pathname)
    target = await redirectTarget(await submitConsent(browser, target, pid))
  }
  return { tokens: await exchangeCode(flow, target), steps }
}

const steveBrowser = new Browser()
await steveBrowser.request('/api/auth/sign-in/email', { json: steve })
let codeFlowTokens: Record<string, any> | undefined

// ---------------------------------------------------------------- 基本能力

await check('用户主键是数据库自增整数', async () => {
  const row = await db.selectFrom('users').select('id').where('email', '=', steve.email).executeTakeFirstOrThrow()
  assert.equal(String(userSteve.id), String(row.id))
  const columns = (await db.introspection.getTables()).find((t) => t.name === 'users')!.columns
  assert.match(columns.find((c) => c.name === 'id')!.dataType.toLowerCase(), /int|serial/)
})

await check('旧版 bcrypt($2y$) 密码可以登录，登录后被重新哈希', async () => {
  const response = await new Browser().request('/api/auth/sign-in/email', { json: legacy })
  assert.equal(response.status, 200, await response.clone().text())
  const row = await db.selectFrom('account').select('password').where('userId', '=', Number(userLegacy.id)).executeTakeFirstOrThrow()
  assert.ok(!String(row.password).startsWith('$2'), `still legacy hash: ${String(row.password).slice(0, 7)}`)
  assert.equal((await new Browser().request('/api/auth/sign-in/email', { json: legacy })).status, 200)
})

await check('发现文档满足 Yggdrasil Connect 要求', async () => {
  const response = await auth.handler(new Request(`${BASE_URL}/api/auth/.well-known/openid-configuration`))
  const meta = (await response.json()) as Record<string, any>
  for (const s of ['openid', SCOPE.select, SCOPE.join]) assert.ok(meta.scopes_supported.includes(s), `missing scope ${s}`)
  assert.ok(meta.id_token_signing_alg_values_supported.includes('RS256'), 'RS256 not advertised')
  assert.ok(meta.device_authorization_endpoint, 'no device_authorization_endpoint')
  assert.ok(meta.userinfo_endpoint && meta.token_endpoint && meta.jwks_uri)
  assert.equal(meta.shared_client_id, shared.client_id)
})

await check('scope 组合规则：缺 openid / Select+Read / Join 无 Select 均返回 invalid_scope', async () => {
  const bad = [SCOPE.join, `openid ${SCOPE.select} ${SCOPE.read}`, `openid ${SCOPE.join}`]
  for (const s of bad) {
    for (const method of ['GET', 'POST'] as const) {
      const { response } = await startAuthorize(steveBrowser, launcher, LAUNCHER_URI, s, { method })
      const text = await response.text()
      assert.ok(response.status >= 400 && text.includes('invalid_scope'), `authorize ${method} ${s}: ${response.status} ${text.slice(0, 200)}`)
    }
    const device = await new Browser().request('/api/auth/device/code', { form: { client_id: shared.client_id, scope: s } })
    assert.ok(device.status >= 400 && (await device.text()).includes('invalid_scope'), `device ${s}`)
  }
})

await check('授权码流：同意页选择角色 → 令牌；ID 令牌 RS256 且含 selectedProfile', async () => {
  const { tokens, steps } = await authorizationCodeFlow(steveBrowser, launcher, LAUNCHER_URI, FULL, pAlex.pid)
  assert.deepEqual(steps, ['/oauth/consent'])
  assert.equal(tokens.token_type, 'Bearer')
  assert.ok(tokens.access_token && tokens.refresh_token && tokens.id_token, 'missing token')
  const header = decodeProtectedHeader(tokens.id_token)
  assert.equal(header.alg, 'RS256')
  assert.ok(header.kid, 'no kid')
  const { payload } = await jwtVerify(tokens.id_token, await jwks(), { audience: launcher.client_id })
  assert.deepEqual(payload.selectedProfile, profile(pAlex))
  codeFlowTokens = tokens
})

await check('userinfo 返回 selectedProfile', async () => {
  const response = await new Browser().request('/api/auth/oauth2/userinfo', { bearer: codeFlowTokens!.access_token })
  const info = (await response.json()) as Record<string, any>
  assert.equal(response.status, 200, JSON.stringify(info))
  assert.deepEqual(info.selectedProfile, profile(pAlex))
})

await check('会话服务器能按令牌取出绑定角色与 Server.Join scope', async () => {
  const verified = await verifyJoinToken(db, codeFlowTokens!.access_token)
  assert.ok(verified, 'token rejected')
  assert.equal(verified.pid, pAlex.pid)
  assert.ok(verified.scopes.includes(SCOPE.join))
})

await check('刷新令牌：保持角色绑定；旧刷新令牌不可重用', async () => {
  const form = { grant_type: 'refresh_token', client_id: launcher.client_id, client_secret: launcher.client_secret! }
  const refreshed = await token({ ...form, refresh_token: codeFlowTokens!.refresh_token })
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body))
  const { payload } = await jwtVerify(refreshed.body.id_token, await jwks(), { audience: launcher.client_id })
  assert.deepEqual(payload.selectedProfile, profile(pAlex))
  assert.equal((await verifyJoinToken(db, refreshed.body.access_token))?.pid, pAlex.pid)
  const replay = await token({ ...form, refresh_token: codeFlowTokens!.refresh_token })
  assert.ok(replay.status >= 400, `replay accepted: ${JSON.stringify(replay.body)}`)
})

await check('未申请 offline_access 时不发刷新令牌', async () => {
  const { tokens } = await authorizationCodeFlow(steveBrowser, launcher, LAUNCHER_URI, `openid ${SCOPE.select}`, pSteve.pid)
  assert.equal(tokens.refresh_token, undefined)
})

await check('Read scope：ID 令牌与 userinfo 都带 availableProfiles', async () => {
  const { tokens } = await authorizationCodeFlow(steveBrowser, launcher, LAUNCHER_URI, `openid ${SCOPE.read}`, null)
  const { payload } = await jwtVerify(tokens.id_token, await jwks(), { audience: launcher.client_id })
  assert.deepEqual((payload.availableProfiles as { name: string }[]).map((p) => p.name).sort(), ['Alex', 'Steve'])
  const info = (await (await new Browser().request('/api/auth/oauth2/userinfo', { bearer: tokens.access_token })).json()) as any
  assert.deepEqual(info.availableProfiles?.map((p: { name: string }) => p.name).sort(), ['Alex', 'Steve'])
})

await check('同意时不能选择别人的角色', async () => {
  const flow = await startAuthorize(steveBrowser, launcher, LAUNCHER_URI, FULL)
  const consentPage = await redirectTarget(flow.response)
  const response = await submitConsent(steveBrowser, consentPage, pOther.pid)
  assert.equal(response.status, 400, await response.clone().text())
})

await check('申请 Select 时每次授权都进入同意页；不申请时机密客户端复用同意', async () => {
  const again = await authorizationCodeFlow(steveBrowser, launcher, LAUNCHER_URI, FULL, pSteve.pid)
  assert.deepEqual(again.steps, ['/oauth/consent'])
  await authorizationCodeFlow(steveBrowser, launcher, LAUNCHER_URI, 'openid offline_access', null)
  const reused = await authorizationCodeFlow(steveBrowser, launcher, LAUNCHER_URI, 'openid offline_access', null)
  assert.deepEqual(reused.steps, [])
})

await check('公共客户端每次授权都要求同意（第二次仍进入同意页）', async () => {
  const first = await authorizationCodeFlow(steveBrowser, shared, SHARED_URI, 'openid', null)
  const second = await authorizationCodeFlow(steveBrowser, shared, SHARED_URI, 'openid', null)
  assert.deepEqual(first.steps, ['/oauth/consent'])
  assert.deepEqual(second.steps, ['/oauth/consent'])
})

/** 设备流工具 */
async function newDevice(requestedScope = FULL) {
  const response = await new Browser().request('/api/auth/device/code', { form: { client_id: shared.client_id, scope: requestedScope } })
  const codes = (await response.json()) as Record<string, any>
  assert.equal(response.status, 200, JSON.stringify(codes))
  return codes
}
const pollDevice = (codes: Record<string, any>) =>
  token({ grant_type: DEVICE_CODE_GRANT_TYPE, device_code: codes.device_code, client_id: shared.client_id })
const selectDevice = (browser: Browser, userCode: string, pid: number) =>
  browser.request('/api/auth/ygg/device/select-profile', { json: { userCode, pid } })
const approveDevice = (browser: Browser, userCode: string) => browser.request('/api/auth/device/approve', { json: { userCode } })

await check('设备代码流：选择角色 → 批准 → 轮询得到绑定角色的令牌', async () => {
  const codes = await newDevice()
  assert.equal((await pollDevice(codes)).body.error, 'authorization_pending')
  assert.equal((await steveBrowser.request(`/api/auth/device?user_code=${codes.user_code}`)).status, 200)
  assert.ok((await approveDevice(steveBrowser, codes.user_code)).status >= 400, 'approved without selecting a profile')
  const intruder = new Browser()
  await intruder.request('/api/auth/sign-in/email', { json: other })
  assert.equal((await selectDevice(intruder, codes.user_code, pOther.pid)).status, 403)
  assert.equal((await selectDevice(steveBrowser, codes.user_code, pSteve.pid)).status, 200)
  assert.equal((await approveDevice(steveBrowser, codes.user_code)).status, 200)
  await wait(5100) // 遵守轮询间隔，否则会收到 slow_down
  const issued = await pollDevice(codes)
  assert.equal(issued.status, 200, JSON.stringify(issued.body))
  const { payload } = await jwtVerify(issued.body.id_token, await jwks(), { audience: shared.client_id })
  assert.deepEqual(payload.selectedProfile, profile(pSteve))
  assert.equal((await verifyJoinToken(db, issued.body.access_token))?.pid, pSteve.pid)
  assert.ok(issued.body.refresh_token, 'no refresh token')
})

// ---------------------------------------------------------------- 回归：独立审核发现的问题

await check('回归：同一用户并行两个授权流程，各自绑定自己选的角色', async () => {
  const a = await startAuthorize(steveBrowser, launcher, LAUNCHER_URI, FULL)
  const b = await startAuthorize(steveBrowser, launcher, LAUNCHER_URI, FULL)
  const consentA = await redirectTarget(a.response)
  const consentB = await redirectTarget(b.response)
  const callbackB = await redirectTarget(await submitConsent(steveBrowser, consentB, pAlex.pid))
  const callbackA = await redirectTarget(await submitConsent(steveBrowser, consentA, pSteve.pid))
  const tokensA = await exchangeCode(a, callbackA)
  const tokensB = await exchangeCode(b, callbackB)
  assert.equal((await verifyJoinToken(db, tokensA.access_token))?.pid, pSteve.pid)
  assert.equal((await verifyJoinToken(db, tokensB.access_token))?.pid, pAlex.pid)
  assert.deepEqual(decodeJwt(tokensA.id_token).selectedProfile, profile(pSteve))
})

await check('回归：同意时只接受部分 scope，不能得到"有 Join 无绑定角色"的令牌', async () => {
  const flow = await startAuthorize(steveBrowser, shared, SHARED_URI, FULL)
  const consentPage = await redirectTarget(flow.response)
  const reduced = await submitConsent(steveBrowser, consentPage, pSteve.pid, `openid ${SCOPE.join}`)
  assert.equal(reduced.status, 400)
  assert.match(await reduced.text(), /invalid_scope/)
  // 被拒绝的同意不应落库；随后 POST 形式的 authorize 也要经过同样的 scope 校验
  const post = await startAuthorize(steveBrowser, shared, SHARED_URI, `openid ${SCOPE.join}`, { method: 'POST' })
  assert.ok(post.response.status >= 400, `POST authorize accepted: ${post.response.status}`)
})

await check('回归：刷新时缩小 scope 也要满足组合规则', async () => {
  const { tokens } = await authorizationCodeFlow(steveBrowser, launcher, LAUNCHER_URI, FULL, pSteve.pid)
  const form = { grant_type: 'refresh_token', client_id: launcher.client_id, client_secret: launcher.client_secret! }
  const bad = await token({ ...form, refresh_token: tokens.refresh_token, scope: `openid ${SCOPE.join}` })
  assert.equal(bad.status, 400, JSON.stringify(bad.body))
  assert.equal(bad.body.error, 'invalid_scope')
  const narrowed = await token({ ...form, refresh_token: tokens.refresh_token, scope: 'openid offline_access' })
  assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body))
  assert.equal(await verifyJoinToken(db, narrowed.body.access_token), null, 'token without Join must not be accepted for join')
})

await check('回归：公共客户端的强制同意不能被 POST、空 oauth_query 或 prompt=none 绕过', async () => {
  await authorizationCodeFlow(steveBrowser, shared, SHARED_URI, 'openid', null)
  const post = await startAuthorize(steveBrowser, shared, SHARED_URI, 'openid', { method: 'POST' })
  assert.equal((await redirectTarget(post.response)).pathname, '/oauth/consent')
  const empty = await startAuthorize(steveBrowser, shared, SHARED_URI, 'openid', { method: 'POST', extra: { oauth_query: '' } })
  assert.equal((await redirectTarget(empty.response)).pathname, '/oauth/consent')
  for (const method of ['GET', 'POST'] as const) {
    const none = await startAuthorize(steveBrowser, shared, SHARED_URI, 'openid', { method, extra: { prompt: 'none' } })
    assert.ok(none.response.status >= 400, `prompt=none ${method} issued without interaction: ${none.response.status}`)
    assert.match(await none.response.text(), /consent_required/)
  }
})

await check('回归：设备码批准后不能再更换角色', async () => {
  const codes = await newDevice()
  await steveBrowser.request(`/api/auth/device?user_code=${codes.user_code}`)
  assert.equal((await selectDevice(steveBrowser, codes.user_code, pSteve.pid)).status, 200)
  assert.equal((await approveDevice(steveBrowser, codes.user_code)).status, 200)
  assert.equal((await selectDevice(steveBrowser, codes.user_code, pAlex.pid)).status, 400)
  await wait(5100)
  const issued = await pollDevice(codes)
  assert.equal((await verifyJoinToken(db, issued.body.access_token))?.pid, pSteve.pid)
  const leftover = await db.selectFrom('yggDeviceSelection').selectAll().where('deviceCode', '=', codes.device_code).execute()
  assert.equal(leftover.length, 0, 'selection not cleaned up after redemption')
})

await check('回归：改写格式的 user code 不能绕过"先选角色"检查', async () => {
  const codes = await newDevice()
  await steveBrowser.request(`/api/auth/device?user_code=${codes.user_code}`)
  const variant = String(codes.user_code).toLowerCase().split('').join('-')
  const approve = await approveDevice(steveBrowser, variant)
  assert.ok(approve.status >= 400, `approved via ${variant} without selection: ${approve.status}`)
})

await check('回归：设备码 id 被复用时不会继承旧设备码的角色选择', async () => {
  // 设备码 A 选 Alex 并兑换；之后的设备码 B 可能拿到同一个自增 id（SQLite）
  const a = await newDevice()
  await steveBrowser.request(`/api/auth/device?user_code=${a.user_code}`)
  await selectDevice(steveBrowser, a.user_code, pAlex.pid)
  await approveDevice(steveBrowser, a.user_code)
  await wait(5100)
  assert.equal((await pollDevice(a)).status, 200)
  const b = await newDevice()
  await steveBrowser.request(`/api/auth/device?user_code=${b.user_code}`)
  assert.ok((await approveDevice(steveBrowser, b.user_code)).status >= 400, 'B approved without its own selection')
  assert.equal((await selectDevice(steveBrowser, b.user_code, pSteve.pid)).status, 200)
  assert.equal((await approveDevice(steveBrowser, b.user_code)).status, 200)
  await wait(5100)
  const issued = await pollDevice(b)
  assert.equal((await verifyJoinToken(db, issued.body.access_token))?.pid, pSteve.pid)
})

await check('回归：拒绝后选择记录被清理，也不能再选择', async () => {
  const codes = await newDevice()
  await steveBrowser.request(`/api/auth/device?user_code=${codes.user_code}`)
  await selectDevice(steveBrowser, codes.user_code, pSteve.pid)
  assert.equal((await steveBrowser.request('/api/auth/device/deny', { json: { userCode: codes.user_code } })).status, 200)
  const leftover = await db.selectFrom('yggDeviceSelection').selectAll().where('deviceCode', '=', codes.device_code).execute()
  assert.equal(leftover.length, 0)
  assert.equal((await selectDevice(steveBrowser, codes.user_code, pAlex.pid)).status, 400)
})

await check('回归：角色转给别人后，旧令牌不能再用于进服', async () => {
  const { tokens } = await authorizationCodeFlow(steveBrowser, launcher, LAUNCHER_URI, FULL, pAlex.pid)
  assert.equal((await verifyJoinToken(db, tokens.access_token))?.pid, pAlex.pid)
  await db.updateTable('players').set({ uid: Number(userOther.id) }).where('pid', '=', pAlex.pid).execute()
  assert.equal(await verifyJoinToken(db, tokens.access_token), null)
  await db.updateTable('players').set({ uid: Number(userSteve.id) }).where('pid', '=', pAlex.pid).execute()
})

// ---------------------------------------------------------------- 输出

console.log(`\n== S1 / ${dialect} ==`)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`)
await db.destroy()
process.exit(results.every((r) => r.ok) ? 0 : 1)
