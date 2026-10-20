import { createTranslator } from '@nextskin/i18n'
import { expect, test, type Page } from '@playwright/test'
import { nextskin } from './nextskin-cli'

// 验证码（ADR-0038）。启用之后登录、注册都要过验证码，和别的用例共用一个站点会让它们失败，
// 所以跑在单并发的 plugins 服务上（playwright.config.ts），最后用命令行关掉。
// 不连外网：浏览器里把 Turnstile 的脚本换成假的挂件。服务端的核对换不掉，假令牌在服务商那里必定通不过：
// 连得上时是不通过或密钥不对，连不上时是核对不了，所以只测不依赖核对结果的行为
const t = createTranslator('zh-CN')
const suffix = String(Date.now()).slice(-6)
const password = 'correct horse battery staple'
const TURNSTILE = 'https://challenges.cloudflare.com/**'

test.use({ locale: 'zh-CN' })

/** 假的 Turnstile：渲染一个按钮，点了就交出令牌；reset 的次数记在 window 上 */
const fakeTurnstile = `(() => {
  const onload = new URL(document.currentScript.src).searchParams.get('onload')
  let next = 0
  window.captchaResets = 0
  window.turnstile = {
    render(element, options) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = 'e2e captcha'
      button.onclick = () => options.callback('e2e-token')
      element.append(button)
      return String(next++)
    },
    reset() {
      window.captchaResets++
    },
    remove() {},
  }
  window[onload]()
})()`

async function fakeWidget(page: Page) {
  await page.route(TURNSTILE, (route) => route.fulfill({ contentType: 'text/javascript', body: fakeTurnstile }))
}

function cli(...args: string[]) {
  nextskin(process.env.NEXTSKIN_E2E_PLUGINS_DATA_DIR, ...args)
}

test('启用验证码后，登录、注册、找回密码都要先过挂件，令牌放在请求头里；命令行能关掉它', async ({ page, browser }) => {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.160' })
  const email = `captcha${suffix}@example.test`
  const registered = await page.request.post('/api/register', {
    data: { email, password, playerName: `Captcha${suffix}` },
  })
  expect(registered.status()).toBe(201)
  cli('set-role', email, 'superadmin')

  // 没启用时页面不加载服务商的脚本
  const visitorContext = await browser.newContext({ locale: 'zh-CN' })
  // 和别的用例错开 IP：Better Auth 按 IP 限制登录次数
  await visitorContext.setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.161' })
  const visitor = await visitorContext.newPage()
  const scripts: string[] = []
  visitor.on('request', (request) => {
    if (request.url().startsWith('https://challenges.cloudflare.com/')) scripts.push(request.url())
  })
  await visitor.goto('/sign-in')
  await expect(visitor.getByRole('group', { name: t('captcha.label') })).toHaveCount(0)
  expect(scripts).toEqual([])

  // 后台的测试按钮没启用时不能点
  await page.goto('/admin/settings/captcha')
  await expect(page.getByRole('button', { name: t('admin.settings.testCaptcha.button') })).toBeDisabled()

  const enabled = await page.request.patch('/api/admin/settings', {
    data: {
      values: {
        'captcha.provider': 'turnstile',
        'captcha.siteKey': '1x00000000000000000000AA',
        'captcha.secretKey': 'e2e-not-a-real-secret',
        // 没配置邮件时找回密码页不显示表单；验证码先拦下请求，不会真的发信
        'mail.transport': 'smtp',
        'mail.from': { address: 'noreply@example.test', name: '' },
      },
    },
  })
  expect(enabled.status()).toBe(200)
  try {
    await fakeWidget(visitor)

    // 登录：没过挂件就提交，提示先完成验证码，不发请求
    await visitor.goto('/sign-in')
    const widget = visitor.getByRole('group', { name: t('captcha.label') })
    await expect(widget.getByRole('button', { name: 'e2e captcha' })).toBeVisible()
    let signInRequests = 0
    visitor.on('request', (request) => {
      if (request.url().endsWith('/api/auth/sign-in/email')) signInRequests++
    })
    await visitor.getByLabel(t('auth.email')).fill(email)
    await visitor.getByLabel(t('auth.password')).fill(password)
    await visitor.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
    await expect(visitor.getByText(t('errors.captcha_required'))).toBeVisible()
    expect(signInRequests).toBe(0)

    // 过了挂件再提交：令牌在请求头里；假令牌通不过，提示原因，挂件重置
    await widget.getByRole('button', { name: 'e2e captcha' }).click()
    const signIn = visitor.waitForRequest('**/api/auth/sign-in/email')
    await visitor.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
    expect((await signIn).headers()['x-captcha-response']).toBe('e2e-token')
    await expect(
      visitor.getByText(t('errors.captcha_failed')).or(visitor.getByText(t('errors.captcha_unavailable'))),
    ).toBeVisible({ timeout: 20_000 })
    expect(await visitor.evaluate(() => (window as unknown as { captchaResets: number }).captchaResets)).toBe(1)

    // 直接调接口：不带令牌 400
    const bare = await visitor.request.post('/api/auth/sign-in/email', { data: { email, password } })
    expect(bare.status()).toBe(400)
    expect(((await bare.json()) as { code: string }).code).toBe('captcha_required')

    // 注册和找回密码同样
    await visitor.goto('/sign-up')
    await expect(visitor.getByRole('group', { name: t('captcha.label') })).toBeVisible()
    const register = await visitor.request.post('/api/register', {
      data: { email: `nocaptcha${suffix}@example.test`, password, playerName: `NoCap${suffix}` },
    })
    expect(register.status()).toBe(400)
    expect(((await register.json()) as { error: { code: string } }).error.code).toBe('captcha_required')
    await visitor.goto('/forgot-password')
    await expect(visitor.getByRole('group', { name: t('captcha.label') })).toBeVisible()
    const reset = await visitor.request.post('/api/auth/request-password-reset', { data: { email } })
    expect(reset.status()).toBe(400)
    expect(((await reset.json()) as { code: string }).code).toBe('captcha_required')

    // 后台的测试：过了挂件，按正式流程核对，结果显示在对话框里
    await fakeWidget(page)
    await page.goto('/admin/settings/captcha')
    await page.getByRole('button', { name: t('admin.settings.testCaptcha.button') }).click()
    const dialog = page.getByRole('dialog', { name: t('admin.settings.testCaptcha.title') })
    await dialog.getByRole('button', { name: 'e2e captcha' }).click()
    await dialog.getByRole('button', { name: t('admin.settings.testCaptcha.verify') }).click()
    await expect(
      dialog
        .getByText(t('admin.settings.testCaptcha.failed'), { exact: true })
        .or(dialog.getByText(t('admin.settings.testCaptcha.unavailable'), { exact: true })),
    ).toBeVisible({ timeout: 20_000 })
  } finally {
    cli('disable-captcha')
    await page.request.patch('/api/admin/settings', {
      data: { values: { 'mail.transport': 'none', 'mail.from': { address: '', name: '' } } },
    })
  }

  // 关掉以后登录照常，挂件不见了，也不再加载脚本
  const loaded = scripts.length
  await visitor.goto('/sign-in')
  await expect(visitor.getByRole('group', { name: t('captcha.label') })).toHaveCount(0)
  await visitor.getByLabel(t('auth.email')).fill(email)
  await visitor.getByLabel(t('auth.password')).fill(password)
  await visitor.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
  await visitor.waitForURL('/user')
  expect(scripts).toHaveLength(loaded)
  await visitorContext.close()
})
