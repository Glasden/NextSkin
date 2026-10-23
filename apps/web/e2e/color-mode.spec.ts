import { createTranslator } from '@nextskin/i18n'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// 亮暗模式（DESIGN.md §10）经过 standalone 产物：<head> 里的内联脚本是序列化的函数，生产构建压缩之后也要能跑
const t = createTranslator('zh-CN')
const COOKIE = 'nextskin-color-mode'

test.use({ locale: 'zh-CN' })

declare global {
  interface Window {
    modeAtBody?: string
  }
}

/** 记下开始解析 <body> 时 <html> 上的 data-mode：这时还没有绘制，取到对的值就不会先闪一下别的颜色 */
async function recordModeAtBody(page: Page) {
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (!document.body) return
      window.modeAtBody = document.documentElement.dataset.mode ?? 'unset'
      observer.disconnect()
    }).observe(document, { childList: true, subtree: true })
  })
}

const modeAtBody = (page: Page) => page.evaluate(() => window.modeAtBody)
const savedMode = async (page: Page) => (await page.context().cookies()).find((cookie) => cookie.name === COOKIE)?.value

test('没有偏好时跟随系统：绘制之前就设好，系统切换时跟着变', async ({ page }) => {
  await recordModeAtBody(page)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-mode', 'dark')
  expect(await modeAtBody(page)).toBe('dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html).toHaveAttribute('data-mode', 'light')
})

test('在页头固定成暗色：记在 Cookie 里，刷新后不跟随系统；改回跟随系统时删掉 Cookie', async ({ page }) => {
  await recordModeAtBody(page)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-mode', 'light')

  const trigger = page.getByRole('banner').getByRole('button', { name: t('site.colorMode.label') })
  await trigger.click()
  await expect(page.getByRole('menuitemradio', { name: t('site.colorMode.system') })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.getByRole('menuitemradio', { name: t('site.colorMode.dark') }).click()
  await expect(html).toHaveAttribute('data-mode', 'dark')
  expect(await savedMode(page)).toBe('dark')

  await page.reload()
  await expect(html).toHaveAttribute('data-mode', 'dark')
  expect(await modeAtBody(page)).toBe('dark')
  await trigger.click()
  await expect(page.getByRole('menuitemradio', { name: t('site.colorMode.dark') })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.getByRole('menuitemradio', { name: t('site.colorMode.system') }).click()
  await expect(html).toHaveAttribute('data-mode', 'light')
  expect(await savedMode(page)).toBeUndefined()
})

test('认证页也能切换亮暗模式', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/sign-in')
  await page.getByRole('button', { name: t('site.colorMode.label') }).click()
  await page.getByRole('menuitemradio', { name: t('site.colorMode.light') }).click()
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
  expect(await savedMode(page)).toBe('light')
})
