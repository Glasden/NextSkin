import { createHmac } from 'node:crypto'
import { createTranslator } from '@nextskin/i18n'
import { expect, test, type Page } from '@playwright/test'
import { authorization, clickHydrated, createLauncherClient, listenCallback, waitForCallback } from './oauth-client'

// 个人资料、两步验证、通行密钥和删除账号经过 standalone 产物的主流程（ADR-0023）。跑在 account 项目上：
// 这个服务的站点地址就是浏览器的 Origin（playwright.config.ts），Better Auth 才接受页面发来的请求。
// 播种数据没有配置邮件，改邮箱走立即生效的那条路。每个用例用自己的 TEST-NET 地址注册，互不占用同一 IP 的注册名额
const t = createTranslator('zh-CN')
const en = createTranslator('en')
const password = 'correct horse battery staple'
const suffix = String(Date.now()).slice(-6)

test.use({ locale: 'zh-CN' })

async function register(page: Page, ip: string, name: string) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip })
  const email = `${name.toLowerCase()}@example.test`
  const response = await page.request.post('/api/register', { data: { email, password, playerName: name } })
  expect(response.status()).toBe(201)
  return email
}

/** RFC 6238：Base32 密钥 → 30 秒一个计数 → HMAC-SHA1 的六位验证码 */
function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = [...secret.toUpperCase().replace(/[\s=]/g, '')]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, '0'))
    .join('')
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const hmac = createHmac('sha1', key).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0xf
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** 页头的用户菜单以昵称为名，注册时昵称就是角色名 */
async function signOut(page: Page, nickname: string) {
  await page.getByRole('button', { name: nickname }).click()
  await page.getByRole('menuitem', { name: t('user.menu.signOut') }).click()
  await expect(page).toHaveURL('/sign-in')
}

async function signIn(page: Page, email: string, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  await page.getByLabel(t('auth.email')).fill(email)
  await page.getByLabel(t('auth.password')).fill(password)
  await page.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
}

test('改邮箱、改昵称和界面语言', async ({ page }) => {
  const name = `Pf${suffix}`
  await register(page, '203.0.113.70', name)
  await page.goto('/user/profile')
  await expect(page.getByRole('heading', { level: 1, name: t('user.profile.title') })).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: t('user.nav.label') }).getByRole('link', { name: t('user.nav.profile') }),
  ).toHaveAttribute('aria-current', 'page')

  // 没有配置邮件：密码不对时错误挂在密码框下；对了就立即改好
  const email = page.getByRole('region', { name: t('user.profile.email.title') })
  const changed = `changed-${suffix}@example.test`
  await email.getByLabel(t('user.profile.email.new')).fill(changed)
  await email.getByLabel(t('user.profile.email.password')).fill('wrong password here')
  await email.getByRole('button', { name: t('user.profile.email.submitNow') }).click()
  await expect(email.getByLabel(t('user.profile.email.password'))).toHaveAccessibleDescription(
    t('errors.password_incorrect'),
  )
  await email.getByLabel(t('user.profile.email.password')).fill(password)
  await email.getByRole('button', { name: t('user.profile.email.submitNow') }).click()
  await expect(page.getByText(t('user.profile.email.changed', { email: changed }))).toBeVisible()
  await expect(page.getByRole('region', { name: t('user.profile.summary.title'), exact: true })).toContainText(changed)

  // 昵称和语言一起保存，刷新后页面换成英文
  const basics = page.getByRole('region', { name: t('user.profile.basics.title') })
  await basics.getByLabel(t('user.profile.basics.nickname')).fill('Steve the Builder')
  await basics.getByRole('combobox', { name: t('user.profile.basics.locale') }).click()
  await page.getByRole('option', { name: 'English' }).click()
  await basics.getByRole('button', { name: t('user.profile.basics.save') }).click()
  await expect(page.getByRole('heading', { level: 1, name: en('user.profile.title') })).toBeVisible()
  await expect(page.getByRole('region', { name: en('user.profile.summary.title'), exact: true })).toContainText(
    'Steve the Builder',
  )
})

test('两步验证：开启后用密码登录要过第二步，备用码也能用', async ({ page }) => {
  const name = `Tf${suffix}`
  const email = await register(page, '203.0.113.71', name)
  await page.goto('/user/security')
  await expect(page.getByRole('heading', { level: 1, name: t('user.security.title') })).toBeVisible()

  await page.getByRole('button', { name: t('user.security.twoFactor.enable') }).click()
  const dialog = page.getByRole('dialog', { name: t('user.security.twoFactor.enable') })
  await dialog.getByLabel(t('user.security.password.current')).fill(password)
  await dialog.getByRole('button', { name: t('user.security.twoFactor.continue') }).click()
  await expect(dialog.getByRole('img', { name: t('user.security.twoFactor.qrLabel') })).toBeVisible()
  const secret = (await dialog.locator('code').textContent())!
  // 错的验证码不会开启
  await dialog.getByLabel(t('user.security.twoFactor.code')).fill(totp(secret) === '000000' ? '111111' : '000000')
  await dialog.getByRole('button', { name: t('user.security.twoFactor.verify') }).click()
  await expect(dialog.getByLabel(t('user.security.twoFactor.code'))).toHaveAccessibleDescription(
    new RegExp(t('user.security.twoFactor.invalidCode')),
  )
  await dialog.getByLabel(t('user.security.twoFactor.code')).fill(totp(secret))
  await dialog.getByRole('button', { name: t('user.security.twoFactor.verify') }).click()
  const items = dialog.getByRole('list', { name: t('user.security.backupCodes.label') }).getByRole('listitem')
  await expect(items).toHaveCount(10)
  const codes = await items.allTextContents()
  await dialog.getByRole('button', { name: t('user.security.twoFactor.done') }).click()
  await expect(page.getByText(t('user.security.twoFactor.enabled'))).toBeVisible()
  await expect(page.getByText(t('user.security.twoFactor.remaining', { count: 10 }))).toBeVisible()

  // 密码通过后进入第二步，用验证器的数字登录
  await signOut(page, name)
  await signIn(page, email, '/user/security')
  await expect(page).toHaveURL(`/sign-in/two-factor?next=${encodeURIComponent('/user/security')}`)
  await page.getByLabel(t('auth.twoFactor.code')).fill(totp(secret))
  await page.getByRole('button', { name: t('auth.twoFactor.submit'), exact: true }).click()
  await expect(page).toHaveURL('/user/security')

  // 改用备用码登录；用过的那个不能再用
  await signOut(page, name)
  await signIn(page, email, '/user/security')
  await expect(page).toHaveURL(/\/sign-in\/two-factor/)
  await page.getByRole('button', { name: t('auth.twoFactor.useBackup') }).click()
  await page.getByLabel(t('auth.twoFactor.backupCode')).fill(codes[0]!)
  await page.getByRole('button', { name: t('auth.twoFactor.submit'), exact: true }).click()
  await expect(page).toHaveURL('/user/security')
  await expect(page.getByText(t('user.security.twoFactor.remaining', { count: 9 }))).toBeVisible()

  // 从授权流程进来：密码、第二步以后回到授权流程，到同意页（ADR-0037"登录后续跑"）
  const clientId = `e2e-two-factor-${suffix}`
  createLauncherClient(email, clientId)
  const port = await listenCallback(page)
  await signOut(page, name)
  const flow = authorization(clientId, port)
  await page.goto(flow.url)
  await expect(page).toHaveURL(/\/sign-in\?.*sig=/)
  await page.getByLabel(t('auth.email')).fill(email)
  await page.getByLabel(t('auth.password')).fill(password)
  await page.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
  await expect(page).toHaveURL(/\/sign-in\/two-factor\?next=%2Fapi%2Fauth%2Foauth2%2Fauthorize/)
  await page.getByRole('button', { name: t('auth.twoFactor.useBackup') }).click()
  await page.getByLabel(t('auth.twoFactor.backupCode')).fill(codes[1]!)
  await page.getByRole('button', { name: t('auth.twoFactor.submit'), exact: true }).click()
  await expect(page).toHaveURL(/\/oauth\/consent\?/)
  await clickHydrated(page.getByRole('button', { name: t('oauth.approve'), exact: true }))
  expect((await waitForCallback(page, port)).get('state')).toBe(flow.state)

  // 关闭两步验证要输入密码
  await page.goto('/user/security')
  await page.getByRole('button', { name: t('user.security.twoFactor.disable') }).click()
  const disable = page.getByRole('alertdialog', { name: t('user.security.twoFactor.disableTitle') })
  await disable.getByLabel(t('user.security.password.current')).fill(password)
  await disable.getByRole('button', { name: t('user.security.twoFactor.disable') }).click()
  await expect(page.getByText(t('user.security.twoFactor.disabled'))).toBeVisible()
  await expect(page.getByRole('button', { name: t('user.security.twoFactor.enable') })).toBeVisible()
})

test('通行密钥：添加、改名，用它登录，删除', async ({ page }) => {
  // Chromium 的虚拟认证器：浏览器调起通行密钥时由它自动应答
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable')
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  })
  const name = `Pk${suffix}`
  const email = await register(page, '203.0.113.72', name)
  await page.goto('/user/security')
  const section = page.getByRole('region', { name: t('user.security.passkeys.title') })
  await expect(section.getByText(t('user.security.passkeys.empty'))).toBeVisible()

  await section.getByRole('button', { name: t('user.security.passkeys.add') }).click()
  const add = page.getByRole('dialog', { name: t('user.security.passkeys.add') })
  await add.getByLabel(t('user.security.passkeys.name')).fill('E2E 认证器')
  await add.getByRole('button', { name: t('user.security.passkeys.create') }).click()
  await expect(page.getByText(t('user.security.passkeys.added', { name: 'E2E 认证器' }))).toBeVisible()
  await expect(section.getByText('E2E 认证器')).toBeVisible()

  await section.getByRole('button', { name: t('user.security.passkeys.rename') }).click()
  const rename = page.getByRole('dialog', { name: t('user.security.passkeys.renameTitle') })
  await rename.getByLabel(t('user.security.passkeys.name')).fill('工作电脑')
  await rename.getByRole('button', { name: t('user.security.passkeys.renameSubmit') }).click()
  await expect(section.getByText('工作电脑')).toBeVisible()

  // 用通行密钥登录不经过两步验证，也不用输入邮箱。登录页还会把通行密钥挂在邮箱框的自动填充上，虚拟认证器
  // 有时不等选择就应答它、抢在点击之前登录，有时不应答，所以让浏览器报告不支持自动填充，只走按钮。
  // 清 Cookie 退出，只打开一次登录页：认证参数是页面打开以后才取的，取到之前点按钮只会报错
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false)
  })
  await page.context().clearCookies()
  const options = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/auth/passkey/generate-authenticate-options',
  )
  await page.goto(`/sign-in?next=${encodeURIComponent('/user/security')}`)
  await options
  await page.getByRole('button', { name: t('auth.signIn.passkey') }).click()
  await expect(page).toHaveURL('/user/security')
  const session = (await page.evaluate(() => fetch('/api/auth/get-session').then((res) => res.json()))) as {
    user: { email: string }
  }
  expect(session.user.email).toBe(email)

  // 从授权流程进来：用通行密钥登录以后回到授权流程，到同意页（ADR-0037"登录后续跑"）
  const clientId = `e2e-passkey-${suffix}`
  createLauncherClient(email, clientId)
  const port = await listenCallback(page)
  await page.context().clearCookies()
  const flow = authorization(clientId, port)
  const signedOptions = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/auth/passkey/generate-authenticate-options',
  )
  await page.goto(flow.url)
  await expect(page).toHaveURL(/\/sign-in\?.*sig=/)
  await signedOptions
  await page.getByRole('button', { name: t('auth.signIn.passkey') }).click()
  await expect(page).toHaveURL(/\/oauth\/consent\?/)
  await clickHydrated(page.getByRole('button', { name: t('oauth.deny'), exact: true }))
  expect((await waitForCallback(page, port)).get('error')).toBe('access_denied')
  await page.goto('/user/security')

  await section.getByRole('button', { name: t('user.security.passkeys.delete') }).click()
  const remove = page.getByRole('alertdialog', { name: t('user.security.passkeys.deleteTitle', { name: '工作电脑' }) })
  await remove.getByRole('button', { name: t('user.security.passkeys.deleteConfirm') }).click()
  await expect(page.getByText(t('user.security.passkeys.deleted', { name: '工作电脑' }))).toBeVisible()
  await expect(section.getByText(t('user.security.passkeys.empty'))).toBeVisible()
})

test('删除账号：密码不对时不删；删除后会话失效，可以用同一个邮箱重新注册', async ({ page }) => {
  const name = `Dl${suffix}`
  const email = await register(page, '203.0.113.73', name)
  await page.goto('/user/profile')
  await page.getByRole('button', { name: t('user.profile.delete.button') }).click()
  const dialog = page.getByRole('alertdialog', { name: t('user.profile.delete.dialogTitle') })
  // 注册时一起创建的角色写在后果里
  await expect(dialog).toContainText(t('user.profile.delete.impactPlayers', { count: 1 }))
  await dialog.getByLabel(t('user.profile.delete.password')).fill('wrong password here')
  await dialog.getByRole('button', { name: t('user.profile.delete.confirm') }).click()
  await expect(dialog.getByLabel(t('user.profile.delete.password'))).toHaveAccessibleDescription(
    t('errors.password_incorrect'),
  )
  await dialog.getByLabel(t('user.profile.delete.password')).fill(password)
  await dialog.getByRole('button', { name: t('user.profile.delete.confirm') }).click()
  await expect(page).toHaveURL('/')
  const session: unknown = await page.evaluate(() => fetch('/api/auth/get-session').then((res) => res.json()))
  expect(session).toBeNull()
  await page.goto('/user')
  await expect(page).toHaveURL('/sign-in?next=%2Fuser')
  // 邮箱和角色名都释放了
  const again = await page.request.post('/api/register', { data: { email, password, playerName: name } })
  expect(again.status()).toBe(201)
})
