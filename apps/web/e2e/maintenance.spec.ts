import { createTranslator } from '@nextskin/i18n'
import { expect, test } from './fixtures'
import { nextskin } from './nextskin-cli'

// 手动维护模式（ADR-0044）。开着时除了管理员谁都用不了站点，和别的用例共用一个站点会让它们失败，
// 所以跑在单并发的 plugins 服务上（playwright.config.ts），最后用命令行关掉。
// 页面换成维护页是 proxy.ts 做的，只有这里测得到；接口的分类在 packages/api 的测试里逐条测过
const t = createTranslator('zh-CN')
const suffix = String(Date.now()).slice(-6)
const password = 'correct horse battery staple'

test.use({ locale: 'zh-CN' })

function cli(...args: string[]) {
  nextskin(process.env.NEXTSKIN_E2E_PLUGINS_DATA_DIR, ...args)
}

test('开启维护后，别人看到维护页、只能登录，管理员照常并看到提示；游戏服务按设置停；命令行能开关', async ({
  page,
  browser,
}) => {
  // 维护开着时不能注册：先注册好超级管理员和一个普通用户。错开 IP，Better Auth 按 IP 限制登录次数
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.190' })
  const adminEmail = `upkeep${suffix}@example.test`
  const registered = await page.request.post('/api/register', {
    data: { email: adminEmail, password, playerName: `Upkeep${suffix}` },
  })
  expect(registered.status()).toBe(201)
  cli('set-role', adminEmail, 'superadmin')

  const userContext = await browser.newContext({ locale: 'zh-CN' })
  await userContext.setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.191' })
  const user = await userContext.newPage()
  const userRegistered = await user.request.post('/api/register', {
    data: { email: `tenant${suffix}@example.test`, password, playerName: `Tenant${suffix}` },
  })
  expect(userRegistered.status()).toBe(201)

  const visitorContext = await browser.newContext({ locale: 'zh-CN' })
  await visitorContext.setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.192' })
  const visitor = await visitorContext.newPage()

  const enabled = await page.request.patch('/api/admin/settings', {
    data: { values: { 'maintenance.enabled': true, 'maintenance.message': '## 迁移服务器\n\n预计 22:00 结束。' } },
  })
  expect(enabled.status()).toBe(200)
  try {
    // 没登录的访客：地址不变，换成维护页，显示站长的说明；管理员登录的链接带着原来的地址
    const maintenance = await visitor.goto('/skinlib')
    expect(maintenance?.headers()['content-security-policy']).toContain("'strict-dynamic'")
    expect(maintenance?.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
    await expect(visitor.getByRole('heading', { name: t('maintenance.title'), level: 1 })).toBeVisible()
    await expect(visitor).toHaveURL(/\/skinlib$/)
    await expect(visitor.getByRole('heading', { name: '迁移服务器' })).toBeVisible()
    await expect(visitor.getByText(t('maintenance.protocolsOpen'))).toBeVisible()
    await expect(visitor.getByRole('link', { name: t('maintenance.adminSignIn') })).toHaveAttribute(
      'href',
      '/sign-in?next=%2Fskinlib',
    )
    // 登录页照常开放；注册的页面和接口都关了
    await visitor.goto('/sign-in')
    await expect(visitor.getByRole('heading', { name: t('auth.signIn.title') })).toBeVisible()
    await visitor.goto('/sign-up')
    await expect(visitor.getByRole('heading', { name: t('maintenance.title'), level: 1 })).toBeVisible()
    const register = await visitor.request.post('/api/register', {
      data: { email: `late${suffix}@example.test`, password, playerName: `Late${suffix}` },
    })
    expect(register.status()).toBe(503)
    expect(await register.json()).toMatchObject({ error: { code: 'site_maintenance' } })
    // 游戏服务默认照常
    expect((await visitor.request.get('/api/yggdrasil')).status()).toBe(200)

    // 普通用户：登录着也只看到维护页，能退出登录（好换管理员的账号）
    await user.goto('/user/players')
    await expect(user.getByRole('heading', { name: t('maintenance.title'), level: 1 })).toBeVisible()
    await expect(user.getByText(t('maintenance.notAdmin'))).toBeVisible()
    await expect(user.getByRole('button', { name: t('user.banned.signOut') })).toBeVisible()
    expect((await user.request.get('/api/closet')).status()).toBe(503)

    // 超级管理员照常使用，页头下方提醒维护还开着，链接到维护设置
    await page.goto('/user')
    const notice = page.getByRole('complementary', { name: t('site.maintenance.label') })
    await expect(notice).toContainText(t('site.maintenance.notice', { protocols: 'open' }))
    await notice.getByRole('link', { name: t('site.maintenance.settings') }).click()
    await expect(page).toHaveURL(/\/admin\/settings\/maintenance$/)
    await expect(
      page.getByRole('checkbox', { name: t('admin.settings.fields.maintenance.enabled.label') }),
    ).toBeChecked()

    // 连游戏服务一起停：Yggdrasil 也是 503，维护页和提示跟着改说法
    const blocked = await page.request.patch('/api/admin/settings', {
      data: { values: { 'maintenance.blockProtocols': true } },
    })
    expect(blocked.status()).toBe(200)
    expect((await visitor.request.get('/api/yggdrasil')).status()).toBe(503)
    await visitor.goto('/')
    await expect(visitor.getByText(t('maintenance.protocolsBlocked'))).toBeVisible()
    await page.goto('/user')
    await expect(page.getByRole('complementary', { name: t('site.maintenance.label') })).toContainText(
      t('site.maintenance.notice', { protocols: 'blocked' }),
    )

    // 命令行关掉：访客回到原来的页面，管理员的提示也没了
    cli('maintenance', 'off')
    await visitor.goto('/skinlib')
    await expect(visitor.getByRole('heading', { name: t('maintenance.title'), level: 1 })).toHaveCount(0)
    expect((await visitor.request.get('/api/yggdrasil')).status()).toBe(200)
    await page.goto('/user')
    await expect(page.getByRole('complementary', { name: t('site.maintenance.label') })).toHaveCount(0)
    // 不在维护时打开维护页，跳回首页
    await visitor.goto('/maintenance')
    await expect(visitor).toHaveURL(/\/$/)

    // 命令行再开：不用登录后台也能挂上维护页
    cli('maintenance', 'on')
    await visitor.goto('/')
    await expect(visitor.getByRole('heading', { name: t('maintenance.title'), level: 1 })).toBeVisible()
  } finally {
    cli('maintenance', 'off')
    await page.request.patch('/api/admin/settings', {
      data: { values: { 'maintenance.blockProtocols': false, 'maintenance.message': '' } },
    })
    await userContext.close()
    await visitorContext.close()
  }
})
