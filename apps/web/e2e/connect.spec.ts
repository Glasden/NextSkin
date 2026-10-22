import { createPublicKey, verify, type JsonWebKey } from 'node:crypto'
import { createTranslator } from '@nextskin/i18n'
import type { APIRequestContext } from '@playwright/test'
import { expect, test } from './fixtures'
import { authorization, clickHydrated, createLauncherClient, listenCallback, waitForCallback } from './oauth-client'

// Yggdrasil Connect 经过 standalone 产物。设备码流程（ADR-0037 切片一）：启动器取代码、用户在 /device 登录并授权、
// 启动器换出令牌进服、在安全页取消授权。授权码流程（切片二）：没登录时登录或注册以后回到授权流程、在同意页选角色、
// 带着授权码回到应用，以及几种错误的去向。跑在 account 项目上：页面登录要求站点地址等于浏览器的 Origin。
// 每个用例用自己的 TEST-NET 地址注册，不占别的用例的注册名额
const t = createTranslator('zh-CN')
const password = 'correct horse battery staple'
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const SCOPE = 'openid offline_access Yggdrasil.PlayerProfiles.Select Yggdrasil.Server.Join'

test.use({ locale: 'zh-CN' })

type Jwk = JsonWebKey & { kid: string }

/** 启动器那一侧：按 RS256 和 JWKS 里同一个 kid 的公钥校验 ID 令牌（PCL-CE 校验 kid、aud） */
async function verifyIdToken(request: APIRequestContext, idToken: string) {
  const [header, payload, signature] = idToken.split('.') as [string, string, string]
  const { alg, kid } = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg: string; kid?: string }
  expect(alg).toBe('RS256')
  const jwks = (await (await request.get('/api/auth/jwks')).json()) as { keys: Jwk[] }
  // SJMCL 只用 keys[0]：只有一把密钥
  expect(jwks.keys).toHaveLength(1)
  expect(kid).toBe(jwks.keys[0]!.kid)
  const key = createPublicKey({ key: jwks.keys[0]!, format: 'jwk' })
  expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, 'base64url'))).toBe(true)
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
}

test('设备码授权：登录后回到批准页、换出令牌进服，取消授权后令牌失效', async ({ page, playwright, baseURL }) => {
  const suffix = String(Date.now()).slice(-6)
  const name = `Dc${suffix}`
  const email = `device-${suffix}@example.test`
  // 注册会登录，拿到会话 Cookie；启动器那一侧另用一个不带 Cookie 的上下文：Better Auth 拒绝带 Cookie、不带 Origin 的 POST
  const registrar = await playwright.request.newContext({ baseURL })
  const registered = await registrar.post('/api/register', {
    headers: { 'x-forwarded-for': '203.0.113.180' },
    data: { email, password, playerName: name },
  })
  expect(registered.status()).toBe(201)
  await registrar.dispose()
  const request = await playwright.request.newContext({ baseURL })

  // 启动器先读元数据和发现文档：站点是 http，不给 openid_configuration_url；发现文档里有公用应用
  const discovery = (await (await request.get('/api/auth/.well-known/openid-configuration')).json()) as Record<
    string,
    unknown
  >
  expect(discovery).toMatchObject({
    issuer: `${baseURL}/api/auth`,
    device_authorization_endpoint: `${baseURL}/api/auth/device/code`,
    shared_client_id: 'shared',
  })

  const created = await request.post('/api/auth/device/code', { form: { client_id: 'shared', scope: SCOPE } })
  expect(created.status()).toBe(200)
  const code = (await created.json()) as { device_code: string; user_code: string; verification_uri_complete: string }
  const poll = () =>
    request.post('/api/auth/oauth2/token', {
      form: { grant_type: DEVICE_CODE_GRANT, device_code: code.device_code, client_id: 'shared' },
    })
  expect(await (await poll()).json()).toMatchObject({ error: 'authorization_pending' })

  // 没登录时去登录页，登录后带着代码回来
  await page.goto(code.verification_uri_complete)
  await expect(page).toHaveURL(/\/sign-in\?next=/)
  await page.getByLabel(t('auth.email')).fill(email)
  await page.getByLabel(t('auth.password')).fill(password)
  await page.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
  await expect(page).toHaveURL(`/device?user_code=${encodeURIComponent(code.user_code)}`)

  // 只有一个角色时默认选中，仍要点"授权"；展台上站着这个角色
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('device.requestTitle'))
  await expect(page.getByText(t('oauth.sharedHint'))).toBeVisible()
  await expect(page.getByText(`${code.user_code.slice(0, 4)}-${code.user_code.slice(4)}`)).toBeVisible()
  await expect(page.getByRole('radio', { name })).toBeChecked()
  await clickHydrated(page.getByRole('button', { name: t('oauth.approve'), exact: true }))
  await expect(page.getByRole('heading', { level: 1, name: t('device.approvedTitle') })).toBeVisible()

  // 启动器按 5 秒的间隔轮询，太快会收到 slow_down
  let tokens: { access_token: string; refresh_token: string; id_token: string } | undefined
  await expect
    .poll(
      async () => {
        const response = await poll()
        const body = (await response.json()) as Record<string, unknown>
        if (response.status() === 200) tokens = body as unknown as typeof tokens
        return response.status() === 200 ? 'ok' : body.error
      },
      { timeout: 20_000, intervals: [1000] },
    )
    .toBe('ok')
  const claims = await verifyIdToken(request, tokens!.id_token)
  expect(claims).toMatchObject({ iss: `${baseURL}/api/auth`, aud: 'shared', selectedProfile: { name } })
  expect(tokens!.refresh_token).toEqual(expect.any(String))

  const profileId = (claims.selectedProfile as { id: string }).id
  const serverId = `connect-server-${suffix}`
  const joined = await request.post('/api/yggdrasil/sessionserver/session/minecraft/join', {
    data: { accessToken: tokens!.access_token, selectedProfile: profileId, serverId },
  })
  expect(joined.status()).toBe(204)
  const hasJoined = await request.get('/api/yggdrasil/sessionserver/session/minecraft/hasJoined', {
    params: { username: name, serverId },
  })
  expect(hasJoined.status()).toBe(200)
  expect(await hasJoined.json()).toMatchObject({ id: profileId, name })
  const validate = () =>
    request.post('/api/yggdrasil/authserver/validate', { data: { accessToken: tokens!.access_token } })
  expect((await validate()).status()).toBe(204)

  // 启动器兑换过的代码再打开就是"代码不存在"；输入时大小写不论
  await page.goto(`/device?user_code=${code.user_code.toLowerCase()}`)
  await expect(page.getByText(t('device.invalid'))).toBeVisible()

  // 安全页：已授权的应用里有公用应用和绑定的角色，取消授权后令牌失效
  await page.goto('/user/security')
  const rows = page.locator('#authorizations li').filter({ hasText: t('user.security.authorizations.revoke') })
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText(t('user.security.authorizations.players', { names: name }))
  await rows.getByRole('button', { name: t('user.security.authorizations.revoke'), exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: t('user.security.authorizations.revokeConfirm'), exact: true }).click()
  await expect(page.locator('#authorizations')).toContainText(t('user.security.authorizations.empty'))
  expect((await validate()).status()).toBe(403)
  const refreshed = await request.post('/api/auth/oauth2/token', {
    form: { grant_type: 'refresh_token', refresh_token: tokens!.refresh_token, client_id: 'shared' },
  })
  expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' })
  await request.dispose()
})

test('批准页不许嵌进别的网站：带 X-Frame-Options 和 frame-ancestors', async ({ page, request }) => {
  const suffix = String(Date.now()).slice(-6)
  const email = `frame-${suffix}@example.test`
  const registered = await page.request.post('/api/register', {
    headers: { 'x-forwarded-for': '203.0.113.181' },
    data: { email, password, playerName: `Fr${suffix}` },
  })
  expect(registered.status()).toBe(201)
  const response = await page.goto('/device')
  expect(response?.status()).toBe(200)
  expect(response?.headers()['x-frame-options']).toBe('DENY')
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
  // 全站页面都不许被嵌入（ADR-0053）。
  const home = await request.get('/')
  expect(home.headers()['x-frame-options']).toBe('DENY')
  expect(home.headers()['content-security-policy']).toContain("frame-ancestors 'none'")

  // 输错代码：显示错误，表单里留着刚才输的
  await page.getByLabel(t('device.code')).fill('wrong-code')
  await page.getByRole('button', { name: t('device.continue'), exact: true }).click()
  await expect(page).toHaveURL('/device?user_code=wrong-code')
  await expect(page.getByText(t('device.invalid'))).toBeVisible()
  await expect(page.getByLabel(t('device.code'))).toHaveValue('wrong-code')
})

// —— 授权码流程（切片二）——

async function register(request: APIRequestContext, ip: string, email: string, playerName: string) {
  const registered = await request.post('/api/register', {
    headers: { 'x-forwarded-for': ip },
    data: { email, password, playerName },
  })
  expect(registered.status()).toBe(201)
}

test('授权码：没登录时登录、回到同意页选角色，带着授权码回到应用，换出令牌进服', async ({
  page,
  playwright,
  baseURL,
}) => {
  const suffix = String(Date.now()).slice(-6)
  const name = `Ac${suffix}`
  const email = `code-${suffix}@example.test`
  // 注册会登录；应用那一侧另用一个不带 Cookie 的上下文：Better Auth 拒绝带 Cookie、不带 Origin 的 POST
  const registrar = await playwright.request.newContext({ baseURL })
  await register(registrar, '203.0.113.182', email, name)
  await registrar.dispose()
  const request = await playwright.request.newContext({ baseURL })
  const clientId = `e2e-launcher-${suffix}`
  createLauncherClient(email, clientId)
  const port = await listenCallback(page)
  // 登录按 IP 限流，和别的用例错开
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.182' })
  const flow = authorization(clientId, port)

  // 注册时拿到的 Cookie 在另一个上下文里，浏览器这边还没登录：去登录页，地址上是签过名的参数
  await page.goto(flow.url)
  await expect(page).toHaveURL(/\/sign-in\?.*sig=/)
  await page.getByLabel(t('auth.email')).fill(email)
  await page.getByLabel(t('auth.password')).fill(password)
  await page.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()

  // 登录以后重新打开授权地址，公共客户端每次都要同意
  await expect(page).toHaveURL(/\/oauth\/consent\?/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('oauth.consent.title'))
  await expect(page.getByText('E2E Launcher')).toBeVisible()
  await expect(page.getByText(`127.0.0.1:${port}`)).toBeVisible()
  await expect(page.getByText(t('oauth.consent.loopback'))).toBeVisible()
  await expect(page.getByText(t('oauth.scopes.serverJoin'))).toBeVisible()
  // 只有一个角色时默认选中，仍要点"授权"
  await expect(page.getByRole('radio', { name })).toBeChecked()
  await clickHydrated(page.getByRole('button', { name: t('oauth.approve'), exact: true }))

  const callback = await waitForCallback(page, port)
  expect(callback.get('state')).toBe(flow.state)
  expect(callback.get('iss')).toBe(`${baseURL}/api/auth`)
  const code = callback.get('code')
  expect(code).toEqual(expect.any(String))

  // 应用那一侧不带 Cookie 换令牌
  const exchanged = await request.post('/api/auth/oauth2/token', {
    form: {
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: flow.redirectUri,
      client_id: clientId,
      code_verifier: flow.verifier,
    },
  })
  expect(exchanged.status()).toBe(200)
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; id_token: string }
  const claims = await verifyIdToken(request, tokens.id_token)
  expect(claims).toMatchObject({ aud: clientId, selectedProfile: { name } })
  expect(tokens.refresh_token).toEqual(expect.any(String))

  const profileId = (claims.selectedProfile as { id: string }).id
  const serverId = `code-server-${suffix}`
  const joined = await request.post('/api/yggdrasil/sessionserver/session/minecraft/join', {
    data: { accessToken: tokens.access_token, selectedProfile: profileId, serverId },
  })
  expect(joined.status()).toBe(204)

  // 授权码只能用一次
  const replayed = await request.post('/api/auth/oauth2/token', {
    form: {
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: flow.redirectUri,
      client_id: clientId,
      code_verifier: flow.verifier,
    },
  })
  expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' })
  await request.dispose()
})

test('授权码：从登录页去注册，注册以后回到授权流程；拒绝时带着 access_denied 回到应用', async ({
  page,
  playwright,
  baseURL,
}) => {
  const suffix = String(Date.now()).slice(-6)
  const ownerEmail = `owner-${suffix}@example.test`
  const request = await playwright.request.newContext({ baseURL })
  await register(request, '203.0.113.183', ownerEmail, `Ow${suffix}`)
  await request.dispose()
  const clientId = `e2e-signup-${suffix}`
  createLauncherClient(ownerEmail, clientId)
  const port = await listenCallback(page)
  // 页面上的注册也按 IP 计名额
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.184' })
  const flow = authorization(clientId, port)

  await page.goto(flow.url)
  await expect(page).toHaveURL(/\/sign-in\?.*sig=/)
  await page.getByRole('link', { name: t('auth.signIn.signUp') }).click()
  await expect(page).toHaveURL(/\/sign-up\?next=%2Fapi%2Fauth%2Foauth2%2Fauthorize/)
  await page.getByLabel(t('auth.email')).fill(`signup-${suffix}@example.test`)
  await page.getByLabel(t('auth.password')).fill(password)
  await page.getByLabel(t('auth.signUp.playerName')).fill(`Su${suffix}`)
  // 从登录页点链接过来是整页打开，水合之前点提交会按原生表单提交，等水合完再点
  await clickHydrated(page.getByRole('button', { name: t('auth.signUp.submit') }))

  await expect(page).toHaveURL(/\/oauth\/consent\?/)
  await expect(page.getByText(t('oauth.owner', { nickname: `Ow${suffix}` }))).toBeVisible()
  await clickHydrated(page.getByRole('button', { name: t('oauth.deny'), exact: true }))
  const callback = await waitForCallback(page, port)
  expect(callback.get('error')).toBe('access_denied')
  expect(callback.get('state')).toBe(flow.state)
  expect(callback.get('code')).toBeNull()
})

test('授权码的错误：scope 组合不对时回到应用，回调地址没登记时去站内错误页', async ({ page, playwright, baseURL }) => {
  const suffix = String(Date.now()).slice(-6)
  const email = `errors-${suffix}@example.test`
  const request = await playwright.request.newContext({ baseURL })
  await register(request, '203.0.113.185', email, `Er${suffix}`)
  await request.dispose()
  const clientId = `e2e-errors-${suffix}`
  createLauncherClient(email, clientId)
  const port = await listenCallback(page)
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.185' })

  // Select 和 Read 不能同时申请：回调地址可信，带着 invalid_scope、state 和 iss 回去
  const scopeFlow = authorization(
    clientId,
    port,
    'openid Yggdrasil.PlayerProfiles.Select Yggdrasil.PlayerProfiles.Read',
  )
  await page.goto(scopeFlow.url)
  const callback = await waitForCallback(page, port)
  expect(callback.get('error')).toBe('invalid_scope')
  expect(callback.get('state')).toBe(scopeFlow.state)
  expect(callback.get('iss')).toBe(`${baseURL}/api/auth`)

  // 没登记的回调地址：不跳过去，站内错误页只显示说明，不许嵌进别的网站
  const evil = authorization(clientId, port)
  evil.params.set('redirect_uri', 'https://evil.example/callback')
  const response = await page.goto(`/api/auth/oauth2/authorize?${evil.params}`)
  await expect(page).toHaveURL(/\/oauth\/error\?error=invalid_redirect/)
  expect(response?.headers()['x-frame-options']).toBe('DENY')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('oauth.error.title'))
  await expect(page.getByText(t('oauth.error.invalidRedirect'))).toBeVisible()

  // 不存在的应用
  const missing = authorization(`missing-${suffix}`, port)
  await page.goto(missing.url)
  await expect(page).toHaveURL(/\/oauth\/error\?error=invalid_client/)
  await expect(page.getByText(t('oauth.error.invalidClient'))).toBeVisible()

  // 改过的同意页地址：拿一份真的签名参数，把回调地址换掉，验不过签名，显示"已失效"，不显示应用和回调主机
  const signedIn = await page.request.post('/api/auth/sign-in/email', { data: { email, password } })
  expect(signedIn.status()).toBe(200)
  const consentFlow = authorization(clientId, port)
  await page.goto(consentFlow.url)
  await expect(page).toHaveURL(/\/oauth\/consent\?.*sig=/)
  await expect(page.getByText('E2E Launcher')).toBeVisible()
  const tampered = new URL(page.url())
  tampered.searchParams.set('redirect_uri', `http://127.0.0.1:${port + 1}/callback`)
  await page.goto(tampered.pathname + tampered.search)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('oauth.consent.invalidTitle'))
  await expect(page.getByText('E2E Launcher')).toHaveCount(0)
  await expect(page.getByText(`127.0.0.1:${port + 1}`)).toHaveCount(0)
})

test('已登录时第三方网站跨站 POST 发起授权：看不到会话 Cookie，登录页直接回到授权流程', async ({ page, baseURL }) => {
  const suffix = String(Date.now()).slice(-6)
  const name = `Xs${suffix}`
  const email = `cross-${suffix}@example.test`
  // 注册顺带登录，会话 Cookie 留在页面的上下文里
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.186' })
  await register(page.request, '203.0.113.186', email, name)
  const clientId = `e2e-cross-${suffix}`
  createLauncherClient(email, clientId)
  const port = await listenCallback(page)
  const flow = authorization(clientId, port)

  // 应用的网页在 127.0.0.1 上，和站点（localhost）不同站：表单 POST 不带 SameSite=Lax 的 Cookie
  const fields = [...flow.params]
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value.replaceAll('"', '&quot;')}">`)
    .join('')
  await page.route(`http://127.0.0.1:${port}/start`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><form method="post" action="${baseURL}/api/auth/oauth2/authorize">${fields}<button>go</button></form>`,
    }),
  )
  await page.goto(`http://127.0.0.1:${port}/start`)
  await page.getByRole('button', { name: 'go' }).click()

  // Better Auth 以为没登录、跳到登录页；登录页看得到会话，直接回到授权地址，再到同意页
  await expect(page).toHaveURL(/\/oauth\/consent\?/)
  await expect(page.getByRole('radio', { name })).toBeChecked()
  await clickHydrated(page.getByRole('button', { name: t('oauth.approve'), exact: true }))
  const callback = await waitForCallback(page, port)
  expect(callback.get('code')).toEqual(expect.any(String))
  expect(callback.get('state')).toBe(flow.state)
})

test('用户中心：建一个网站应用，用它的密钥走完授权码流程；删除应用以后令牌失效', async ({
  page,
  playwright,
  baseURL,
}) => {
  const suffix = String(Date.now()).slice(-6)
  const email = `site-${suffix}@example.test`
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.187' })
  await register(page.request, '203.0.113.187', email, `Ws${suffix}`)
  const appName = `E2E 论坛 ${suffix}`
  const callback = 'https://forum.example.test/oauth/callback'

  await page.goto('/user/oauth-clients')
  await expect(page.getByText(t('user.oauthClients.emptyTitle'))).toBeVisible()
  await clickHydrated(page.getByRole('button', { name: t('user.oauthClients.create'), exact: true }))
  const dialog = page.getByRole('alertdialog', { name: t('user.oauthClients.create') })
  await dialog.getByLabel(t('user.oauthClients.name')).fill(appName)
  // 网站的回调地址必须是 https：接口拒绝，填过的内容留着，改一下再提交
  const insecure = 'http://forum.example.test/oauth/callback'
  await dialog.getByLabel(t('user.oauthClients.redirectUris')).fill(insecure)
  await dialog.getByRole('button', { name: t('user.oauthClients.create'), exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText(
    t('errors.oauth_redirect_uri_invalid', { uri: insecure, type: 'web' }),
  )
  await dialog.getByLabel(t('user.oauthClients.redirectUris')).fill(callback)
  await dialog.getByRole('button', { name: t('user.oauthClients.create'), exact: true }).click()

  // 密钥只显示这一次
  const created = page.getByRole('alertdialog', { name: t('user.oauthClients.createdTitle', { name: appName }) })
  await expect(created.getByText(t('user.oauthClients.secretOnce'))).toBeVisible()
  const [clientId, secret] = await created.locator('code').allTextContents()
  expect(clientId).toMatch(/^[a-z]{32}$/)
  expect(secret).toMatch(/^[\w-]{43}$/)
  await created.getByRole('button', { name: t('user.oauthClients.done') }).click()
  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: appName }) })
  await expect(card.getByText(clientId!, { exact: true })).toBeVisible()
  await expect(card.getByText(callback, { exact: true })).toBeVisible()
  await expect(card.getByText(t('user.oauthClients.types.web'), { exact: true })).toBeVisible()

  // 第三方网站发起授权：机密客户端第一次要同意；不申请 offline_access，不用 PKCE
  const state = `site-${suffix}`
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId!,
    redirect_uri: callback,
    scope: 'openid profile',
    state,
  })
  // 同意之后页面整页跳到回调地址（不是重定向链），page.route 拦得到
  await page.route(
    (url) => url.href.startsWith(`${callback}?`),
    (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>forum</title>' }),
  )
  await page.goto(`/api/auth/oauth2/authorize?${params}`)
  await expect(page).toHaveURL(/\/oauth\/consent\?/)
  await expect(page.getByText(appName)).toBeVisible()
  await expect(page.getByText('forum.example.test')).toBeVisible()
  await clickHydrated(page.getByRole('button', { name: t('oauth.approve'), exact: true }))
  await page.waitForURL((url) => url.href.startsWith(`${callback}?`))
  const returned = new URL(page.url()).searchParams
  expect(returned.get('state')).toBe(state)

  // 论坛那一侧：HTTP Basic 带上 client_id 和密钥换令牌
  const forum = await playwright.request.newContext({ baseURL })
  const basic = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`
  const exchanged = await forum.post('/api/auth/oauth2/token', {
    headers: { authorization: basic },
    form: { grant_type: 'authorization_code', code: returned.get('code')!, redirect_uri: callback },
  })
  expect(exchanged.status()).toBe(200)
  const { access_token: accessToken } = (await exchanged.json()) as { access_token: string }
  const userinfo = () => forum.get('/api/auth/oauth2/userinfo', { headers: { authorization: `Bearer ${accessToken}` } })
  expect((await userinfo()).status()).toBe(200)

  // 回到用户中心：已授权的用户数是 1；删除以后令牌跟着失效
  await page.goto('/user/oauth-clients')
  await expect(card).toContainText(t('user.oauthClients.meta', { time: '', count: 1 }).split(' · ')[1]!)
  await clickHydrated(card.getByRole('button', { name: t('user.oauthClients.delete'), exact: true }))
  const confirm = page.getByRole('alertdialog', { name: t('user.oauthClients.deleteTitle', { name: appName }) })
  await expect(confirm).toContainText(t('user.oauthClients.deleteDescription', { count: 1 }))
  await confirm.getByRole('button', { name: t('user.oauthClients.deleteConfirm') }).click()
  await expect(page.getByText(t('user.oauthClients.emptyTitle'))).toBeVisible()
  expect((await userinfo()).status()).toBe(401)
  await forum.dispose()
})
