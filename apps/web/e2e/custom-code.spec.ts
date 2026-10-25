import { createTranslator } from '@nextskin/i18n'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { nextskin } from './nextskin-cli'
import { clickHydrated } from './oauth-client'

// 自定义代码（ADR-0063）。页头代码、自定义 CSS 对站点上的每个页面生效，手动维护开着时别人用不了站点，
// 所以跑在单并发的 plugins 服务上（playwright.config.ts），每个用例最后用命令行和接口清掉。
// 不连外网：统计服务的脚本由浏览器里的路由提供，CSP 照样由浏览器执行
const t = createTranslator('zh-CN')
const suffix = String(Date.now()).slice(-6)
const password = 'correct horse battery staple'
const ANALYTICS = 'https://analytics.example.test'

test.use({ locale: 'zh-CN' })

function cli(...args: string[]) {
  nextskin(process.env.NEXTSKIN_E2E_PLUGINS_DATA_DIR, ...args)
}

/** 注册一个超级管理员，page 带着它的会话；各用例错开 IP（按 IP 限制注册次数） */
async function superAdmin(page: Page, name: string, ip: string): Promise<string> {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip })
  const email = `${name.toLowerCase()}${suffix}@example.test`
  const registered = await page.request.post('/api/register', {
    data: { email, password, playerName: `${name}${suffix}` },
  })
  expect(registered.status()).toBe(201)
  cli('set-role', email, 'superadmin')
  return email
}

async function save(page: Page, values: Record<string, string>) {
  const response = await page.request.patch('/api/admin/settings', { data: { values } })
  expect(response.status()).toBe(200)
}

async function clear(page: Page) {
  cli('disable-custom-code')
  await save(page, { 'custom.adsTxt': '' })
}

/** 统计服务的两个脚本：内联代码创建的一个、页头代码里直接写的一个 async 外部脚本 */
async function fakeAnalytics(context: BrowserContext) {
  await context.route(`${ANALYTICS}/**`, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: route.request().url().endsWith('/collect.js') ? 'window.e2eCollected = true' : 'window.e2eAsync = true',
    }),
  )
}

const headCode = `<!-- e2e 统计 -->
<script>
  window.e2eInline = (window.e2eInline || 0) + 1
  window.e2eNavigations = []
  window.addEventListener('nextskin:navigate', (event) => window.e2eNavigations.push(event.detail.path))
  var collect = document.createElement('script')
  collect.src = '${ANALYTICS}/collect.js'
  document.head.appendChild(collect)
  // 统计服务常往页面里插自己的节点（统计图标、挂件），水合不能因此报错
  document.addEventListener('DOMContentLoaded', () => {
    var badge = document.createElement('div')
    badge.id = 'e2e-badge'
    document.body.appendChild(badge)
  })
</script>
<script async src="${ANALYTICS}/async.js" data-site="e2e"></script>
<meta name="google-site-verification" content="e2e-verify">
<noscript><img src="${ANALYTICS}/pixel.gif"></noscript>`

type Probe = { e2eInline?: number; e2eCollected?: boolean; e2eAsync?: boolean; e2eNavigations?: string[] }
const probe = (page: Page) =>
  page.evaluate((): Probe => {
    const { e2eInline, e2eCollected, e2eAsync, e2eNavigations } = window as unknown as Probe
    return { e2eInline, e2eCollected, e2eAsync, e2eNavigations }
  })

/** 在当前文档上做个记号：整页加载以后记号就没了 */
const markDocument = () => {
  ;(window as unknown as { e2eSameDocument?: boolean }).e2eSameDocument = true
}
const sameDocument = () => (window as unknown as { e2eSameDocument?: boolean }).e2eSameDocument === true

test('页头代码：访客的页面执行脚本、带上 meta，客户端跳转派发事件；管理员登录后整页加载、不再运行', async ({
  page,
  browser,
}) => {
  const email = await superAdmin(page, 'HeadCode', '203.0.113.170')
  const visitorContext = await browser.newContext({ locale: 'zh-CN' })
  await visitorContext.setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.171' })
  await fakeAnalytics(visitorContext)
  const visitor = await visitorContext.newPage()
  const errors: string[] = []
  visitor.on('pageerror', (error) => errors.push(error.message))
  visitor.on('console', (message) => {
    if (message.type() === 'error' && /react|hydrat/i.test(message.text())) errors.push(message.text())
  })

  await save(page, { 'custom.head': headCode })
  try {
    await visitor.goto('/')
    await expect.poll(async () => (await probe(visitor)).e2eCollected).toBe(true)
    await expect.poll(async () => (await probe(visitor)).e2eAsync).toBe(true)
    await expect(visitor.locator('#e2e-badge')).toBeAttached()
    expect(await probe(visitor)).toMatchObject({ e2eInline: 1, e2eNavigations: [] })
    await expect(visitor.locator('head meta[name="google-site-verification"]')).toHaveAttribute('content', 'e2e-verify')
    // noscript 收下但不输出
    await expect(visitor.locator('noscript img')).toHaveCount(0)
    // 外部脚本也带上这次请求的 nonce：浏览器会清掉 nonce 的属性值，只能从元素的 nonce 字段读
    expect(
      await visitor.locator('script[data-site="e2e"]').evaluate((element) => (element as HTMLScriptElement).nonce),
    ).not.toBe('')

    // 客户端跳转：页面不重新加载，事件带新页面的路径和查询串
    await visitor
      .getByRole('banner')
      .getByRole('link', { name: t('site.nav.skinlib'), exact: true })
      .click()
    await visitor.waitForURL('**/skinlib')
    await expect.poll(async () => (await probe(visitor)).e2eNavigations).toEqual(['/skinlib'])
    await visitor.goto('/skinlib?sort=likes')
    // 整页打开不派发
    expect(await probe(visitor)).toMatchObject({ e2eInline: 1, e2eNavigations: [] })
    expect(errors).toEqual([])

    // 管理员的页面不加载页头代码
    await page.goto('/')
    expect((await probe(page)).e2eInline).toBeUndefined()
    await expect(page.locator('head meta[name="google-site-verification"]')).toHaveCount(0)

    // 访客在同一个标签页里登录成管理员：整页跳转，之前的脚本不再运行；
    // 另一个标签页共用 Cookie，跑着页头代码的那个也整页重新加载
    const other = await visitorContext.newPage()
    await other.goto('/skinlib')
    expect((await probe(other)).e2eInline).toBe(1)
    await visitor.goto('/sign-in')
    for (const tab of [visitor, other]) await tab.evaluate(markDocument)
    await visitor.getByLabel(t('auth.email')).fill(email)
    await visitor.getByLabel(t('auth.password')).fill(password)
    // 没水合时点提交会走不带脚本的表单 POST，那样本来就是整页跳转，测不出 goToNext
    await clickHydrated(visitor.getByRole('button', { name: t('auth.signIn.submit'), exact: true }))
    await visitor.waitForURL((url) => url.pathname !== '/sign-in')
    for (const tab of [visitor, other]) {
      await expect.poll(() => tab.evaluate(sameDocument)).toBe(false)
      await tab.waitForLoadState()
      expect((await probe(tab)).e2eInline).toBeUndefined()
    }
  } finally {
    await clear(page)
    await visitorContext.close()
  }
})

test('页头代码不合法时，表单在这一项下面写出原因；命令行清空以后，审计里能看到原来的全文', async ({ page }) => {
  await superAdmin(page, 'BadHead', '203.0.113.172')
  const label = t('admin.settings.fields.custom.head.label')
  try {
    await page.goto('/admin/settings/custom')
    const field = page.getByLabel(label, { exact: true })
    await field.fill('<meta name="baidu-site-verification" content="e2e">\n<div>统计图标</div>')
    await page.getByRole('button', { name: t('admin.settings.save') }).click()
    await expect(page.getByText(t('errors.custom_head_invalid', { line: 2, reason: 'tag', tag: 'div' }))).toBeVisible()

    const valid = '<meta name="baidu-site-verification" content="e2e-audit">'
    await field.fill(valid)
    await page.getByRole('button', { name: t('admin.settings.save') }).click()
    await expect(page.getByText(t('admin.settings.saved', { count: 1 }))).toBeVisible()

    cli('disable-custom-code')
    await page.goto('/admin/settings/custom')
    await expect(field).toHaveValue('')

    // 最新一条是命令行清空的那次：改之前是刚才保存的全文
    await page.goto('/admin/audit')
    await page
      .getByRole('row')
      .filter({ hasText: label })
      .first()
      .getByRole('button', { name: t('admin.audit.details.settingUpdate.view') })
      .click()
    const sheet = page.getByRole('dialog', { name: label })
    await expect(sheet.getByText(valid)).toBeVisible()
    await expect(sheet.getByText(t('admin.audit.details.settingUpdate.empty'))).toBeVisible()
  } finally {
    await clear(page)
  }
})

test('自定义 CSS 在前台生效，后台不套用：从前台客户端跳进后台以后就失效', async ({ page, browser }) => {
  await superAdmin(page, 'CustomCss', '203.0.113.173')
  const visitorContext = await browser.newContext({ locale: 'zh-CN' })
  await visitorContext.setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.174' })
  const visitor = await visitorContext.newPage()
  const marker = (target: Page) =>
    target.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--e2e-custom').trim())

  await save(page, { 'custom.css': ':root { --e2e-custom: applied; }' })
  try {
    await visitor.goto('/')
    expect(await marker(visitor)).toBe('applied')

    // 管理员在前台照样套用
    await page.goto('/')
    expect(await marker(page)).toBe('applied')
    await page.goto('/admin')
    expect(await marker(page)).toBe('')

    await page.goto('/user')
    expect(await marker(page)).toBe('applied')
    await clickHydrated(page.getByRole('button', { name: `CustomCss${suffix}` }))
    await page.getByRole('menuitem', { name: t('user.menu.admin') }).click()
    await page.waitForURL('**/admin')
    await expect.poll(() => marker(page)).toBe('')
  } finally {
    await clear(page)
    await visitorContext.close()
  }
})

test('/ads.txt：有内容时返回纯文本，没有时 404；手动维护期间照常', async ({ page, browser }) => {
  await superAdmin(page, 'AdsTxt', '203.0.113.175')
  const visitorContext = await browser.newContext()
  const visitor = visitorContext.request

  expect((await visitor.get('/ads.txt')).status()).toBe(404)
  const content = 'google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0\n'
  await save(page, { 'custom.adsTxt': content })
  try {
    const response = await visitor.get('/ads.txt')
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('text/plain; charset=utf-8')
    expect(await response.text()).toBe(content)

    cli('maintenance', 'on')
    try {
      const register = await visitor.post('/api/register', {
        data: { email: `adslate${suffix}@example.test`, password, playerName: `AdsLate${suffix}` },
      })
      expect(register.status()).toBe(503)
      const during = await visitor.get('/ads.txt')
      expect(during.status()).toBe(200)
      expect(await during.text()).toBe(content)
    } finally {
      cli('maintenance', 'off')
    }
  } finally {
    await clear(page)
    await visitorContext.close()
  }
})
