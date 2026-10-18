import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTranslator } from '@nextskin/i18n'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

// 衣柜、换材质、头像和举报的主流程（ADR-0026）。跑在 account 项目上：上传是 multipart 表单，
// 接口按站点地址检查 Origin（playwright.config.ts）。两个用户各用自己的 TEST-NET 地址注册，不占别的用例的名额
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

async function csl(request: APIRequestContext, player: string) {
  const response = await request.get(`/csl/${player}.json`)
  expect(response.status()).toBe(200)
  return (await response.json()) as { skins: Record<string, string | null> }
}

test('收藏别人的材质换到角色上、设为头像、举报；上传者改成私有后，衣柜、角色和头像里都没有了', async ({
  page,
  browser,
  baseURL,
}) => {
  // 上传者传一张公开的皮肤
  const uploaderContext = await browser.newContext({ locale: 'zh-CN' })
  const uploader = await uploaderContext.newPage()
  await register(uploader, '203.0.113.72', `Owner${suffix}`)
  const textureName = `Haka ${suffix}`
  const uploaded = await uploader.request.post('/api/textures', {
    headers: { Origin: new URL(baseURL!).origin },
    multipart: {
      file: { name: 'haka.png', mimeType: 'image/png', buffer: readFileSync(fixture('haka')) },
      name: textureName,
      type: 'steve',
      public: 'true',
    },
  })
  expect(uploaded.status()).toBe(201)
  const { texture } = (await uploaded.json()) as { texture: { tid: number; hash: string } }

  // 另一个用户在详情页把它加入衣柜，起个自己的名字
  const player = `Col${suffix}`
  await register(page, '203.0.113.73', player)
  await page.goto(`/skinlib/${texture.tid}`)
  await page.getByRole('button', { name: t('skinlib.actions.add') }).click()
  const addDialog = page.getByRole('dialog', { name: t('skinlib.actions.addTitle', { name: textureName }) })
  await addDialog.getByLabel(t('skinlib.actions.name')).fill('上学穿')
  await addDialog.getByRole('button', { name: t('skinlib.actions.add') }).click()
  await expect(page.getByText(t('skinlib.actions.added'), { exact: true })).toBeVisible()
  await expect(page.getByText(t('skinlib.inCloset'), { exact: true })).toBeVisible()

  // 换到自己的角色上，CSL 随即返回它的 hash
  await page.getByRole('button', { name: t('skinlib.actions.setSkin') }).click()
  const applyDialog = page.getByRole('dialog', {
    name: t('user.closet.apply.title', { slot: 'skin', name: '上学穿' }),
  })
  await applyDialog.getByRole('button', { name: t('user.closet.apply.apply') }).click()
  await expect(page.getByText(t('user.closet.apply.applied', { player, name: '上学穿' }))).toBeVisible()
  expect((await csl(page.request, player)).skins).toEqual({ default: texture.hash })

  // 设为头像：按钮变成“当前头像”，个人资料里显示它
  await page.getByRole('button', { name: t('skinlib.actions.setAvatar') }).click()
  await expect(page.getByRole('button', { name: t('skinlib.actions.isAvatar') })).toBeDisabled()
  await page.goto('/user/profile')
  // 没有头像时占位也叫这个名字，所以按 <img> 找
  await expect(page.locator(`img[alt="${t('user.profile.summary.avatarAlt')}"]`)).toBeVisible()

  // 举报：详情页变成“已举报”，“我的举报”里看得到
  await page.goto(`/skinlib/${texture.tid}`)
  await page.getByRole('button', { name: t('skinlib.actions.report'), exact: true }).click()
  const reason = `盗用别人的作品 ${suffix}`
  const reportDialog = page.getByRole('dialog', { name: t('skinlib.actions.reportTitle', { name: textureName }) })
  await reportDialog.getByLabel(t('skinlib.actions.reason')).fill(reason)
  await reportDialog.getByRole('button', { name: t('skinlib.actions.reportConfirm') }).click()
  await expect(page.getByText(t('skinlib.actions.reported'), { exact: true })).toBeVisible()
  await page.goto('/user/reports')
  await expect(page.getByRole('link', { name: textureName })).toHaveAttribute('href', `/skinlib/${texture.tid}`)
  await expect(page.getByText(reason)).toBeVisible()
  await expect(page.getByText(t('user.reports.status.pending'), { exact: true })).toBeVisible()

  // 衣柜里是自己起的名字，卡片指向详情页
  await page.goto('/user/closet')
  await expect(page.getByRole('link', { name: /上学穿/ })).toHaveAttribute('href', `/skinlib/${texture.tid}`)

  // 上传者改成私有：那个用户的衣柜、角色和头像里都没有了
  const changed = await uploader.request.patch(`/api/textures/${texture.tid}`, {
    headers: { Origin: new URL(baseURL!).origin },
    data: { public: false },
  })
  expect(changed.status()).toBe(200)
  await uploaderContext.close()
  await page.reload()
  await expect(page.getByText(t('user.closet.emptyTitle', { type: 'skin' }))).toBeVisible()
  expect((await csl(page.request, player)).skins).toEqual({ default: null })
  await page.goto('/user/profile')
  await expect(page.getByText(t('user.profile.summary.noAvatar'))).toBeVisible()
  // 举报留着，材质已经看不到了
  await page.goto('/user/reports')
  await expect(page.getByText(t('user.reports.textureGone'), { exact: true })).toBeVisible()
})
