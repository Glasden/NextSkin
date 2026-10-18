import { createTranslator } from '@nextskin/i18n'
import { expect, test } from '@playwright/test'

// 首页经过 standalone 产物（ADR-0032）。领奖台的内容由领域层的测试守着：它在进程里缓存 60 秒，
// 这里只看它在不在，不看站了谁
const t = createTranslator('zh-CN')

test.use({ locale: 'zh-CN' })

test('首页有主视觉、领奖台、最新上传、外置登录三步和页脚', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: t('home.title') })).toBeVisible()
  // 没登录、开放注册：主要入口是注册
  await expect(
    page.getByRole('main').getByRole('link', { name: t('home.actions.signUp'), exact: true }),
  ).toHaveAttribute('href', '/sign-up')
  await expect(page.getByRole('heading', { name: t('home.podium.title') })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: t('home.latest.title') })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: t('home.launcher.title') })).toBeVisible()
  await expect(page.getByText(/\/api\/yggdrasil$/)).toBeVisible()

  const footer = page.getByRole('contentinfo')
  await expect(footer.getByText(t('site.footer.poweredBy'))).toBeVisible()
  await expect(footer.getByText(/^© \d{4} /)).toBeVisible()

  // 站点描述没填时，meta description 用首页的默认介绍
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', t('home.description'))
})

// 站点图标由 design:sync 生成，放在 app 目录里按 Next 的文件约定输出（ADR-0032）
test('站点图标的三个文件都在页头里声明并能取到', async ({ page, request }) => {
  await page.goto('/')
  const icons = [
    { selector: 'link[rel="icon"][type="image/svg+xml"]', type: 'image/svg+xml' },
    { selector: 'link[rel="icon"][type="image/x-icon"]', type: 'image/x-icon' },
    { selector: 'link[rel="apple-touch-icon"]', type: 'image/png' },
  ]
  for (const icon of icons) {
    const href = await page.locator(icon.selector).getAttribute('href')
    expect(href).toBeTruthy()
    const response = await request.get(href!)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe(icon.type)
  }
})
