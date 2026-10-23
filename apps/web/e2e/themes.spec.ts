import { readFileSync } from 'node:fs'
import { createTranslator } from '@nextskin/i18n'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { nextskin } from './nextskin-cli'

// 配色主题（ADR-0057、ADR-0058）经过 standalone 产物：后台启用官方插件“更多配色”带来的主题，用户在用户中心选一套，
// 根布局按账号输出 data-theme 和这套主题的 CSS；超级管理员关掉这套以后回落到站点默认。
// 跑在 plugins 项目的服务上（playwright.config.ts），结束时停用插件，不影响同一个服务上的其他用例
const t = createTranslator('zh-CN')
const suffix = String(Date.now()).slice(-6)
const password = 'correct horse battery staple'
const plugin = JSON.parse(
  readFileSync(new URL('../../../plugins/color-themes/locales/zh-CN.json', import.meta.url), 'utf8'),
) as { plugin: { name: string }; themes: { magenta: string; highContrast: string } }
const magentaName = plugin.themes.magenta
const highContrastName = plugin.themes.highContrast

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

/** 后台启用插件“更多配色”，用例结束时停用 */
async function enableColorThemes(page: Page) {
  await page.goto('/admin/plugins/color-themes')
  await page.getByRole('button', { name: t('admin.plugins.enable') }).click()
  await page
    .getByRole('alertdialog', { name: t('admin.plugins.enableTitle', { name: plugin.plugin.name }) })
    .getByRole('button', { name: t('admin.plugins.enableConfirm'), exact: true })
    .click()
  await expect(page.getByText(t('admin.plugins.enabled', { name: plugin.plugin.name }))).toBeVisible()
  restore = () =>
    page.request.post('/api/admin/plugins/color-themes/disable', { headers: { 'content-type': 'application/json' } })
}

/** 后台主题页上这套主题的卡片 */
const themeCard = (page: Page, name: string) =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { name }) })

test('启用插件的主题后用户能选，整页换上；超级管理员关掉这套后回落到站点默认', async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  nextskin(
    process.env.NEXTSKIN_E2E_PLUGINS_DATA_DIR,
    'set-role',
    await register(page, '203.0.113.200', `Theme${suffix}`),
    'superadmin',
  )
  await enableColorThemes(page)

  // 插件带来的主题默认不启用；只有钻石青时用户中心没有主题页的入口
  const userContext = await browser.newContext({ locale: 'zh-CN' })
  const user = await userContext.newPage()
  await user.emulateMedia({ colorScheme: 'light' })
  await register(user, '203.0.113.201', `Pick${suffix}`)
  await user.goto('/user')
  await expect(user.getByRole('link', { name: t('user.nav.theme') })).toHaveCount(0)

  await page.goto('/admin/themes')
  const card = themeCard(page, magentaName)
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

// 高对比连结构一起改（ADR-0058）：直角、粗边框、卡片静止带阴影；亮色下荧光色只当色块，表面上的强调色是黑色
test('高对比换上直角、粗边框和静止带阴影的卡片，亮色下荧光色只当色块；关掉后结构回落', async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  nextskin(
    process.env.NEXTSKIN_E2E_PLUGINS_DATA_DIR,
    'set-role',
    await register(page, '203.0.113.202', `Contrast${suffix}`),
    'superadmin',
  )
  await enableColorThemes(page)
  await page.goto('/admin/themes')
  const card = themeCard(page, highContrastName)
  await card.getByRole('switch', { name: t('admin.themes.enable') }).click()
  await expect(page.getByText(t('admin.themes.enabled', { name: highContrastName }))).toBeVisible()

  const userContext = await browser.newContext({ locale: 'zh-CN' })
  const user = await userContext.newPage()
  await user.emulateMedia({ colorScheme: 'light' })
  await register(user, '203.0.113.203', `Bold${suffix}`)
  await user.goto('/user/theme')
  const html = user.locator('html')
  // 量“跟随站点默认”那张卡片：选完高对比以后它没选中、鼠标也不在它上面，看到的是静止时的样子
  const option = user.getByRole('radio', { name: t('user.theme.followDefault') })
  const structure = () =>
    option.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        raised: style.boxShadow.includes('4px 4px'),
      }
    })
  const diamond = { border: '1px', radius: '4px', raised: false }
  expect(await structure()).toEqual(diamond)

  // 高对比的取值读它自己的小样：小样和整页用的是同一段生成的 CSS。亮色下荧光色只当色块，表面上的强调色另取；
  // 暗色下荧光色在黑底上看得清，表面上的强调色就是它
  const preview = (mode: 'light' | 'dark', name: string) =>
    user
      .locator(`[data-theme="color-themes/high-contrast"][data-mode="${mode}"]`)
      .first()
      .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), name)
  const lightAccent = await preview('light', '--color-accent')
  const neon = await preview('light', '--color-accent-fill')
  expect(neon).not.toBe(lightAccent)
  expect(await preview('dark', '--color-accent')).toBe(neon)

  await user.getByRole('radio', { name: highContrastName }).click()
  await expect(html).toHaveAttribute('data-theme', 'color-themes/high-contrast')
  await expect.poll(structure).toEqual({ border: '2px', radius: '0px', raised: true })
  await expect.poll(() => accent(user)).toBe(lightAccent)
  // 主要按钮的底色是色块那个颜色，亮暗都是荧光色
  await user.goto('/user')
  const checkIn = user.getByRole('button', { name: t('user.dashboard.checkIn') })
  const fill = () => checkIn.evaluate((element) => getComputedStyle(element).getPropertyValue('--button-bg'))
  await expect.poll(fill).toBe(neon)
  await user.emulateMedia({ colorScheme: 'dark' })
  await expect(html).toHaveAttribute('data-mode', 'dark')
  await expect.poll(() => accent(user)).toBe(neon)
  await expect.poll(fill).toBe(neon)
  await user.emulateMedia({ colorScheme: 'light' })

  await page.goto('/admin/themes')
  await card.getByRole('switch', { name: t('admin.themes.enable') }).click()
  await expect(page.getByText(t('admin.themes.disabled', { name: highContrastName }))).toBeVisible()
  await user.goto('/user/theme')
  await expect(html).toHaveAttribute('data-theme', 'diamond')
  await expect.poll(structure).toEqual(diamond)
  await userContext.close()
})
