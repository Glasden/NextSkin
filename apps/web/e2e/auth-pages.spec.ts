import { createTranslator } from '@nextskin/i18n'
import { expect, test } from './fixtures'

// 认证页经过 standalone 产物能用。播种数据的站点地址是录制 BS 时的地址（auth.spec.ts），和浏览器的 Origin 不同，
// Better Auth 会拒绝页面发起的登录，所以这里只走注册（/api/register 是 JSON 接口，不按 Origin 拦）。
// 同一 IP 最多注册 3 个账号：用自己的 TEST-NET 地址，不和其他用例共用
test.use({ locale: 'zh-CN', extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.50' } })

const t = createTranslator('zh-CN')

test('注册页注册成功后带着会话进入用户中心', async ({ page }) => {
  const email = `page-${Date.now()}@example.test`
  await page.goto('/sign-up')
  // 标题是“页面名 · 站点名”，站点名取自播种数据
  expect(await page.title()).toMatch(new RegExp(`^${t('auth.signUp.title')} · `))
  await expect(page.getByRole('img', { name: t('auth.illustration', { name: 'cxchency' }) })).toBeVisible()
  await page.getByLabel(t('auth.email')).fill(email)
  await page.getByLabel(t('auth.password')).fill('correct horse battery staple')
  await page.getByLabel(t('auth.signUp.playerName')).fill('E2EPage')
  await page.getByRole('button', { name: t('auth.signUp.submit') }).click()
  await page.waitForURL('/user')
  const session = (await page.evaluate(() => fetch('/api/auth/get-session').then((res) => res.json()))) as {
    user: { email: string }
  }
  expect(session.user.email).toBe(email)
  // 已登录时打开注册页进入用户中心
  await page.goto('/sign-up')
  await expect(page).toHaveURL('/user')
})

test('注册失败时错误显示在对应的输入框下方', async ({ page }) => {
  const email = `page-taken-${Date.now()}@example.test`
  const register = (playerName: string) =>
    page.request.post('/api/register', {
      data: { email, password: 'correct horse battery staple', playerName },
    })
  expect((await register('E2ETaken')).status()).toBe(201)
  await page.context().clearCookies()
  await page.goto('/sign-up')
  await page.getByLabel(t('auth.email')).fill(email)
  await page.getByLabel(t('auth.password')).fill('correct horse battery staple')
  await page.getByLabel(t('auth.signUp.playerName')).fill('E2EOther')
  await page.getByRole('button', { name: t('auth.signUp.submit') }).click()
  const input = page.getByLabel(t('auth.email'))
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(input).toHaveAccessibleDescription(t('errors.email_taken'))
})

test('页面水合之前提交登录表单：按 POST 提交，密码不进地址', async ({ page }) => {
  // 挡掉页面的脚本，页面一直停在服务端渲染的样子
  await page.route('**/_next/static/**/*.js', (route) => route.abort())
  await page.goto('/sign-in')
  await page.getByLabel(t('auth.email')).fill('prehydration@example.test')
  await page.getByLabel(t('auth.password')).fill('prehydration secret')
  const submitted = page.waitForRequest(
    (request) => request.isNavigationRequest() && request.frame() === page.mainFrame(),
  )
  await page.getByRole('button', { name: t('auth.signIn.submit') }).click()
  const request = await submitted
  expect(request.method()).toBe('POST')
  expect(new URL(request.url()).pathname).toBe('/sign-in')
  expect(request.url()).not.toContain('prehydration')
  await page.waitForLoadState()
  expect(page.url()).not.toContain('prehydration')
})

test('BS 的认证页地址跳到新地址', async ({ request }) => {
  for (const [from, to] of [
    ['/auth/login', '/sign-in'],
    ['/auth/register', '/sign-up'],
    ['/auth/forgot', '/forgot-password'],
  ] as const) {
    const res = await request.get(from, { maxRedirects: 0 })
    expect(res.status()).toBe(308)
    expect(res.headers().location).toBe(to)
  }
})

test('重设密码和验证邮箱的结果页', async ({ page }) => {
  await page.goto('/reset-password?error=INVALID_TOKEN')
  // Next 的路由播报也是 role="alert"，按文字找
  await expect(page.getByRole('alert').filter({ hasText: t('auth.resetPassword.invalidLink') })).toBeVisible()
  await page.goto('/verify-email?status=verified')
  await expect(page.getByRole('status').filter({ hasText: t('auth.verifyEmail.doneTitle') })).toBeVisible()
  await page.goto('/verify-email?status=verified&error=INVALID_TOKEN')
  await expect(page.getByRole('alert').filter({ hasText: t('auth.verifyEmail.invalidLink') })).toBeVisible()
  // 直接打开验证结果页回首页
  await page.goto('/verify-email')
  await expect(page).toHaveURL('/')
})
