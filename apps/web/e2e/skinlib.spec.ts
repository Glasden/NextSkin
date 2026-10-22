import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTranslator } from '@nextskin/i18n'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// 上传、皮肤库、详情页和上传者的管理操作经过 standalone 产物的主流程（ADR-0025）。跑在 account 项目上：
// 上传是 multipart 表单，接口按站点地址检查 Origin，这个服务的站点地址就是浏览器的 Origin（playwright.config.ts）。
// 用自己的 TEST-NET 地址注册，不占其他用例同一 IP 的注册名额
const t = createTranslator('zh-CN')
const suffix = String(Date.now()).slice(-6)
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../packages/skin/test/fixtures/${name}.png`, import.meta.url))

test.use({ locale: 'zh-CN' })

async function register(page: Page, ip: string, name: string) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip })
  const response = await page.request.post('/api/register', {
    data: { email: `${name.toLowerCase()}@example.test`, password: 'correct horse battery staple', playerName: name },
  })
  expect(response.status()).toBe(201)
}

test('上传皮肤、在皮肤库和详情页里看到它，改成私有后别人打不开，删除后退还积分', async ({ page, browser }) => {
  const name = `Lib${suffix}`
  await register(page, '203.0.113.70', name)

  await page.goto('/skinlib/upload')
  await page.locator('input[type="file"]').setInputFiles(fixture('hatsune_miku'))
  // 浏览器本地解码出预览，并按手臂推断出纤细模型
  await expect(
    page.getByRole('img', { name: t('skinlib.upload.previewAlt', { type: t('skinlib.types.alex') }) }),
  ).toBeVisible()
  await expect(page.getByRole('radio', { name: t('skinlib.types.alex') })).toBeChecked()
  const textureName = `初音 ${suffix}`
  await page.getByLabel(t('skinlib.upload.name')).fill(textureName)
  await page.getByRole('button', { name: t('skinlib.upload.submit'), exact: true }).click()
  await expect(page).toHaveURL(/\/skinlib\/\d+$/)
  const tid = Number(page.url().split('/').pop())
  await expect(page.getByRole('heading', { level: 1, name: textureName })).toBeVisible()
  // 3D 预览：取回 PNG、JS 解码后交给 skinview3d
  await expect(page.getByRole('img', { name: t('skinlib.detail.viewer', { name: textureName }) })).toBeVisible()

  // 皮肤库里有它；上传者自己的衣柜里也有它，卡片显示为选中
  await page.goto('/skinlib')
  const card = page.getByRole('link', { name: new RegExp(textureName) })
  await expect(card).toHaveAttribute('href', `/skinlib/${tid}`)
  await expect(card).toHaveAccessibleName(new RegExp(t('skinlib.inCloset')))
  // 2D 正背面由服务端出图，一年的 immutable 缓存
  const src = await card.getByRole('img').getAttribute('src')
  const figure = await page.request.get(src!)
  expect(figure.status()).toBe(200)
  expect(figure.headers()['content-type']).toBe('image/png')
  expect(figure.headers()['cache-control']).toBe('public, max-age=31536000, immutable')

  // 改成私有：皮肤库里不再列出，别人打开详情页是 404
  await page.goto(`/skinlib/${tid}`)
  await page.getByRole('button', { name: t('skinlib.manage.makePrivate') }).click()
  await page
    .getByRole('dialog', { name: t('skinlib.manage.makePrivateTitle', { name: textureName }) })
    .getByRole('button', { name: t('skinlib.manage.makePrivate') })
    .click()
  await expect(page.getByText(t('skinlib.private'), { exact: true })).toBeVisible()
  const anonymous = await browser.newContext()
  const stranger = await anonymous.newPage()
  expect((await stranger.goto(`/skinlib/${tid}`))?.status()).toBe(404)
  await stranger.goto('/skinlib')
  await expect(stranger.getByRole('link', { name: new RegExp(textureName) })).toHaveCount(0)
  await anonymous.close()

  // 删除：回到皮肤库，按实付退还积分
  await page.goto(`/skinlib/${tid}`)
  await page.getByRole('button', { name: t('skinlib.manage.delete') }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: t('skinlib.manage.deleteConfirm') })
    .click()
  await expect(page).toHaveURL('/skinlib')
  await expect(page.getByText(new RegExp(`^已删除 ${textureName}`))).toBeVisible()
  expect((await page.goto(`/skinlib/${tid}`))?.status()).toBe(404)
  // 文件已经没有引用：原图和出图都不再提供
  expect((await page.request.get(src!)).status()).toBe(404)
})

test('同一张图已经公开过，再上传会被拒绝，并指出已有的材质', async ({ page, baseURL }) => {
  await register(page, '203.0.113.71', `Dup${suffix}`)
  // 用其他用例没有公开上传过的图：同一个站点上的用例并行跑，closet.spec.ts 公开的 haka 会让第一次上传就被拒绝
  const upload = () =>
    page.request.post('/api/textures', {
      // multipart 是浏览器跨站也能发的表单请求，接口按站点地址检查 Origin；页面里的 fetch 会自动带上
      headers: { Origin: new URL(baseURL!).origin },
      multipart: {
        file: { name: 'sethbling.png', mimeType: 'image/png', buffer: readFileSync(fixture('sethbling')) },
        name: 'SethBling',
        type: 'steve',
        public: 'true',
      },
    })
  const first = await upload()
  expect(first.status()).toBe(201)
  const second = await upload()
  expect(second.status()).toBe(409)
  expect(((await second.json()) as { error: { code: string } }).error.code).toBe('texture_duplicate')
})

test('BS 的旧详情页地址跳到新地址', async ({ request }) => {
  const response = await request.get('/skinlib/show/12', { maxRedirects: 0 })
  expect(response.status()).toBe(308)
  expect(response.headers().location).toBe('/skinlib/12')
})
