import { readFileSync } from 'node:fs'
import { createTranslator } from '@nextskin/i18n'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { nextskin } from './nextskin-cli'

// 配色主题（ADR-0057）经过 standalone 产物：后台启用官方插件“更多配色”带来的主题，用户在用户中心选一套，
// 根布局按账号输出 data-theme 和这套主题的 CSS；超级管理员关掉这套以后回落到站点默认。
// 跑在 plugins 项目的服务上（playwright.config.ts），结束时停用插件，不影响同一个服务上的其他用例
const t = createTranslator('zh-CN')
const suffix = String(Date.now()).slice(-6)
const password = 'correct horse battery staple'
const plugin = JSON.parse(
  readFileSync(new URL('../../../plugins/color-themes/locales/zh-CN.json', import.meta.url), 'utf8'),
) as { plugin: { name: string }; themes: { magenta: string } }
const magentaName = plugin.themes.magenta

test.use({ locale: 'zh-CN' })

let restore: (() => Promise<unknown>) | undefined
test.afterEach(async () => {
  await restore?.()
  restore = undefined
})

async function register(page: Page, ip: string, name: string) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip })
  const email = `${name.toLowerCase()}@example.test`
  const response = await page.request.post('/api/register', { data: { email, password, playerName: name } })
  expect(response.status()).toBe(201)
  return email
}

const accent = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent'))

test('启用插件的主题后用户能选，整页换上；超级管理员关掉这套后回落到站点默认', async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  nextskin(
    process.env.NEXTSKIN_E2E_PLUGINS_DATA_DIR,
    'set-role',
    await register(page, '203.0.113.200', `Theme${suffix}`),
    'superadmin',
  )
  await page.goto('/admin/plugins/color-themes')
  await page.getByRole('button', { name: t('admin.plugins.enable') }).click()
  await page
    .getByRole('alertdialog', { name: t('admin.plugins.enableTitle', { name: plugin.plugin.name }) })
    .getByRole('button', { name: t('admin.plugins.enableConfirm'), exact: true })
    .click()
  await expect(page.getByText(t('admin.plugins.enabled', { name: plugin.plugin.name }))).toBeVisible()
  restore = () =>
    page.request.post('/api/admin/plugins/color-themes/disable', { headers: { 'content-type': 'application/json' } })

  // 插件带来的主题默认不启用；只有钻石青时用户中心没有主题页的入口
  const userContext = await browser.newContext({ locale: 'zh-CN' })
  const user = await userContext.newPage()
  await user.emulateMedia({ colorScheme: 'light' })
  await register(user, '203.0.113.201', `Pick${suffix}`)
  await user.goto('/user')
  await expect(user.getByRole('link', { name: t('user.nav.theme') })).toHaveCount(0)

  await page.goto('/admin/themes')
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: magentaName }) })
  await card.getByRole('switch', { name: t('admin.themes.enable') }).click()
  await expect(page.getByText(t('admin.themes.enabled', { name: magentaName }))).toBeVisible()

  await user.goto('/user')
  await user
    .getByRole('navigation', { name: t('user.nav.label') })
    .getByRole('link', { name: t('user.nav.theme') })
    .click()
  await expect(user).toHaveURL('/user/theme')
  const html = user.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'diamond')
  const before = await accent(user)
  // 洋红的强调色取自它的亮色小样：小样和整页用的是同一段生成的 CSS
  const magenta = await user
    .locator('[data-theme="color-themes/magenta"][data-mode="light"]')
    .first()
    .evaluate((preview) => getComputedStyle(preview).getPropertyValue('--color-accent'))
  expect(magenta).not.toBe(before)
  await user.getByRole('radio', { name: magentaName }).click()
  await expect(html).toHaveAttribute('data-theme', 'color-themes/magenta')
  await expect.poll(() => accent(user)).toBe(magenta)
  // 存进了账号：换个页面还是这套
  await user.goto('/')
  await expect(html).toHaveAttribute('data-theme', 'color-themes/magenta')
  await expect.poll(() => accent(user)).toBe(magenta)

  // 关掉这套：不改写用户存着的选择，读的时候回落到站点默认，主题页写明原因
  await page.goto('/admin/themes')
  await card.getByRole('switch', { name: t('admin.themes.enable') }).click()
  await expect(page.getByText(t('admin.themes.disabled', { name: magentaName }))).toBeVisible()
  await user.goto('/user/theme')
  await expect(html).toHaveAttribute('data-theme', 'diamond')
  await expect.poll(() => accent(user)).toBe(before)
  await expect(user.getByText(t('user.theme.stale'))).toBeVisible()
  await expect(user.getByRole('radio', { name: t('user.theme.followDefault') })).toBeChecked()
  await userContext.close()
})
