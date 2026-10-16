import { expect, test } from '@playwright/test'

test('首页能打开', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'NextSkin' })).toBeVisible()
})

test('Hono 端点经 Next 的 catch-all 路由可达', async ({ request }) => {
  const res = await request.get('/api/health')
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ status: 'ok' })
})
