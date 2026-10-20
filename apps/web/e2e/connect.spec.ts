import { createPublicKey, verify, type JsonWebKey } from 'node:crypto'
import { createTranslator } from '@nextskin/i18n'
import { expect, test, type APIRequestContext } from '@playwright/test'

// Yggdrasil Connect 的设备码流程（ADR-0037 切片一）经过 standalone 产物：启动器取代码、用户在 /device 登录并授权、
// 启动器换出令牌进服、在安全页取消授权。跑在 account 项目上：页面登录要求站点地址等于浏览器的 Origin。
// 用自己的 TEST-NET 地址注册，不占别的用例的注册名额
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
  await page.getByRole('button', { name: t('device.approve'), exact: true }).click()
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
  expect(response?.headers()['content-security-policy']).toBe("frame-ancestors 'none'")
  // 别的页面不加（全站的 CSP 还没做）
  const home = await request.get('/')
  expect(home.headers()['x-frame-options']).toBeUndefined()

  // 输错代码：显示错误，表单里留着刚才输的
  await page.getByLabel(t('device.code')).fill('wrong-code')
  await page.getByRole('button', { name: t('device.continue'), exact: true }).click()
  await expect(page).toHaveURL('/device?user_code=wrong-code')
  await expect(page.getByText(t('device.invalid'))).toBeVisible()
  await expect(page.getByLabel(t('device.code'))).toHaveValue('wrong-code')
})
