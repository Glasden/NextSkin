import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTranslator } from '@nextskin/i18n'
import { expect, test, type Page } from '@playwright/test'

// 后台的主流程（ADR-0027）：举报 → 管理员删除材质 → 举报人看到已采纳 → 审计日志；封禁上传者 → 他只看到封禁说明，
// CSL 对他的角色返回 403。设置页（ADR-0028）：只有超级管理员能进，改了立即生效。
// 跑在 account 项目上：上传是 multipart 表单，接口按站点地址检查 Origin（playwright.config.ts）。
// 两个用例放在同一个文件里按顺序跑：第一个按条数检查审计日志，另一个文件并行任命管理员会打乱它
const t = createTranslator('zh-CN')
const suffix = String(Date.now()).slice(-6)
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../packages/skin/test/fixtures/${name}.png`, import.meta.url))

test.use({ locale: 'zh-CN' })

async function register(page: Page, ip: string, name: string) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip })
  const email = `${name.toLowerCase()}@example.test`
  const response = await page.request.post('/api/register', {
    data: { email, password: 'correct horse battery staple', playerName: name },
  })
  expect(response.status()).toBe(201)
  return email
}

/** 第一个超级管理员由脚本设定（ADR-0027）。直接改 account 服务的数据目录，和运行中的服务共用一个 SQLite 文件 */
function setRole(email: string, role: string) {
  execFileSync(process.execPath, ['scripts/set-role.ts', email, role], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      NEXTSKIN_DATA_DIR: process.env.NEXTSKIN_E2E_ACCOUNT_DATA_DIR,
      NEXTSKIN_SECRET: process.env.NEXTSKIN_E2E_SECRET,
    },
  })
}

test('举报的材质被管理员删除，举报人看到已采纳；封禁上传者后他的角色在 CSL 里是 403；审计日志都记下了', async ({
  page,
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin

  // 上传者传一张公开的皮肤
  const uploaderContext = await browser.newContext({ locale: 'zh-CN' })
  const uploader = await uploaderContext.newPage()
  const uploaderPlayer = `Up${suffix}`
  await register(uploader, '203.0.113.90', uploaderPlayer)
  const textureName = `盗图 ${suffix}`
  const uploaded = await uploader.request.post('/api/textures', {
    headers: { Origin: origin },
    multipart: {
      file: { name: 'deadmau5.png', mimeType: 'image/png', buffer: readFileSync(fixture('deadmau5')) },
      name: textureName,
      type: 'steve',
      public: 'true',
    },
  })
  expect(uploaded.status()).toBe(201)
  const { texture } = (await uploaded.json()) as { texture: { tid: number } }
  const uploaderNickname = uploaderPlayer

  // 另一个用户举报它
  const reporterContext = await browser.newContext({ locale: 'zh-CN' })
  const reporter = await reporterContext.newPage()
  await register(reporter, '203.0.113.91', `Rep${suffix}`)
  const reason = `盗用别人的原创 ${suffix}`
  const reported = await reporter.request.post('/api/reports', { data: { tid: texture.tid, reason } })
  expect(reported.status()).toBe(201)
  const { id: reportId } = (await reported.json()) as { id: number }

  // 普通用户进不了后台，菜单里也没有入口
  const adminEmail = await register(page, '203.0.113.92', `Adm${suffix}`)
  expect((await page.goto('/admin'))?.status()).toBe(404)
  expect(
    (await page.request.post(`/api/admin/reports/${reportId}/resolve`, { data: { action: 'dismiss' } })).status(),
  ).toBe(403)

  // 设为超级管理员之后，用户菜单里出现“管理后台”，概览提示有举报等着处理
  setRole(adminEmail, 'superadmin')
  await page.goto('/user')
  await page.getByRole('button', { name: `Adm${suffix}` }).click()
  await page.getByRole('menuitem', { name: t('user.menu.admin') }).click()
  await expect(page.getByRole('heading', { name: t('admin.overview.title'), level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: t('admin.overview.pendingAction') })).toBeVisible()

  // 在举报页删除材质：确认框写明后果，删除后这条举报从待处理里消失
  await page.goto('/admin/reports')
  await expect(page.getByText(reason)).toBeVisible()
  await page.getByRole('button', { name: t('admin.reports.handleLabel', { id: reportId }) }).click()
  await page.getByRole('menuitem', { name: t('admin.reports.deleteTexture') }).click()
  const deleteDialog = page.getByRole('alertdialog', { name: t('admin.reports.deleteTitle', { name: textureName }) })
  await expect(deleteDialog).toContainText(t('admin.reports.deleteHint', { closets: 1, others: 0, paid: 0, reward: 0 }))
  await deleteDialog.getByRole('button', { name: t('admin.reports.deleteConfirm') }).click()
  await expect(page.getByText(t('admin.reports.deleted', { name: textureName, others: 0 }))).toBeVisible()
  await expect(page.getByText(reason)).toHaveCount(0)
  await page.goto('/admin/reports?status=resolved')
  await expect(page.getByText(reason)).toBeVisible()
  await expect(page.getByText(t('admin.reports.resolutions.textureDeleted'), { exact: true })).toBeVisible()

  // 举报人在“我的举报”里看到已采纳；材质已经不在了
  await reporter.goto('/user/reports')
  await expect(reporter.getByText(t('user.reports.status.resolved'), { exact: true })).toBeVisible()
  await expect(reporter.getByText(t('user.reports.textureGone'), { exact: true })).toBeVisible()
  expect((await reporter.request.get(`/skinlib/${texture.tid}`)).status()).toBe(404)
  await reporterContext.close()

  // 在用户列表里封禁上传者
  await page.goto(`/admin/users?q=${encodeURIComponent(`up${suffix}`)}`)
  await page.getByRole('button', { name: t('admin.users.manageLabel', { nickname: uploaderNickname }) }).click()
  await page.getByRole('menuitem', { name: t('admin.users.ban') }).click()
  const banDialog = page.getByRole('alertdialog', { name: t('admin.users.banTitle', { nickname: uploaderNickname }) })
  await banDialog.getByRole('button', { name: t('admin.users.banConfirm') }).click()
  await expect(page.getByText(t('admin.users.banned', { nickname: uploaderNickname }))).toBeVisible()
  await expect(page.getByText(t('admin.roles.banned'), { exact: true })).toBeVisible()

  // 上传者只看到封禁说明，他的角色在 CSL 里是 403
  await uploader.goto('/user')
  await expect(uploader.getByRole('heading', { name: t('user.banned.title') })).toBeVisible()
  expect((await uploader.request.get(`/csl/${uploaderPlayer}.json`)).status()).toBe(403)
  await uploaderContext.close()

  // 审计日志：脚本设定的角色、删除材质、处理举报、封禁，都在
  await page.goto('/admin/audit')
  const log = page.getByRole('table', { name: t('admin.audit.tableLabel') })
  await expect(log.getByRole('cell', { name: t('admin.audit.actions.textureDelete'), exact: true })).toBeVisible()
  await expect(log.getByRole('cell', { name: t('admin.audit.actions.reportResolve'), exact: true })).toBeVisible()
  await expect(log.getByRole('cell', { name: t('admin.audit.actions.userSetRole'), exact: true })).toHaveCount(2)
  await expect(log.getByText(t('admin.audit.actorSystem'), { exact: true })).toBeVisible()
})

test('管理员看不到设置；超级管理员改站点名、写公告、生成签名密钥都当场生效', async ({ page, browser }) => {
  const nav = (target: Page) => target.getByRole('navigation', { name: t('admin.nav.label') })

  // 管理员（不是超级管理员）的导航里没有“设置”，直接访问是 404，接口是 403
  const moderatorContext = await browser.newContext({ locale: 'zh-CN' })
  const moderator = await moderatorContext.newPage()
  setRole(await register(moderator, '203.0.113.120', `Mod${suffix}`), 'admin')
  await moderator.goto('/admin')
  await expect(nav(moderator).getByRole('link', { name: t('admin.nav.audit') })).toBeVisible()
  await expect(nav(moderator).getByRole('link', { name: t('admin.nav.settings') })).toHaveCount(0)
  expect((await moderator.goto('/admin/settings/site'))?.status()).toBe(404)
  expect((await moderator.request.patch('/api/admin/settings', { data: { values: {} } })).status()).toBe(403)
  await moderatorContext.close()

  setRole(await register(page, '203.0.113.121', `Own${suffix}`), 'superadmin')
  await page.goto('/admin')
  await nav(page)
    .getByRole('link', { name: t('admin.nav.settings') })
    .click()
  await expect(page).toHaveURL(/\/admin\/settings\/site$/)

  // 站点名：保存后页头跟着变，最后改回去，不影响同一个服务上的其他用例
  const siteName = page.getByLabel(t('admin.settings.fields.site.name.label'))
  const original = await siteName.inputValue()
  const renamed = `像素工坊 ${suffix}`
  await siteName.fill(renamed)
  await expect(page.getByText(t('admin.settings.dirty', { count: 1 }))).toBeVisible()

  // 公告：预览和仪表盘用同一个组件，原始 HTML 不渲染
  const heading = `开服通知 ${suffix}`
  // exact：“预览：公告”按钮的名字里也有“公告”
  await page
    .getByLabel(t('admin.settings.fields.site.announcement.label'), { exact: true })
    .fill(`## ${heading}\n\n生存服地址是 **play.example.test**。\n\n<b>粗体标签</b>`)
  await page
    .getByRole('button', {
      name: t('admin.settings.markdown.buttonLabel', {
        action: t('admin.settings.markdown.preview'),
        label: t('admin.settings.fields.site.announcement.label'),
      }),
    })
    .click()
  const preview = page.getByRole('region', {
    name: t('admin.settings.markdown.previewLabel', { label: t('admin.settings.fields.site.announcement.label') }),
  })
  await expect(preview.getByRole('heading', { level: 3 })).toHaveText(heading)
  await page.getByRole('button', { name: t('admin.settings.save') }).click()
  await expect(page.getByText(t('admin.settings.saved', { count: 2 }))).toBeVisible()
  await expect(page.getByRole('banner').getByText(renamed)).toBeVisible()

  // 仪表盘的“公告”区块是 h2，`##` 渲染成 h4
  await page.goto('/user')
  const announcement = page.getByRole('region', { name: t('user.dashboard.announcement') })
  await expect(announcement.getByRole('heading', { level: 4 })).toHaveText(heading)
  await expect(announcement.locator('strong')).toHaveText('play.example.test')
  await expect(announcement.locator('b')).toHaveCount(0)
  await expect(announcement).toContainText('粗体标签')

  // 字段错误：坏的正则整批拒绝，标在对应的设置项上
  await page.goto('/admin/settings/content')
  const textureRule = page.getByLabel(t('admin.settings.fields.texture.nameRegex.label'))
  await textureRule.fill('(')
  await page.getByRole('button', { name: t('admin.settings.save') }).click()
  await expect(page.getByText(t('admin.settings.invalid'))).toBeVisible()
  await expect(textureRule).toHaveAttribute('aria-invalid', 'true')

  // 签名密钥：已经有了，生成新的要先确认；元数据随即换成新的公钥
  const publicKey = async () =>
    ((await (await page.request.get('/api/yggdrasil')).json()) as { signaturePublickey: string }).signaturePublickey
  const before = await publicKey()
  const keyLabel = t('admin.settings.fields.yggdrasil.signingKey.label')
  await page.goto('/admin/settings/yggdrasil')
  await page.getByRole('button', { name: t('admin.settings.generate.button') }).click()
  await page
    .getByRole('alertdialog', { name: t('admin.settings.generate.title', { label: keyLabel }) })
    .getByRole('button', { name: t('admin.settings.generate.confirm') })
    .click()
  await expect(page.getByText(t('admin.settings.generate.done', { label: keyLabel }))).toBeVisible({ timeout: 15_000 })
  const after = await publicKey()
  expect(after).toContain('BEGIN PUBLIC KEY')
  expect(after).not.toBe(before)

  // 审计日志记下了这几项，签名私钥只写“已重新生成”
  await page.goto('/admin/audit')
  const log = page.getByRole('table', { name: t('admin.audit.tableLabel') })
  await expect(log.getByRole('row').filter({ hasText: keyLabel }).first()).toContainText(
    t('admin.audit.details.settingUpdate.generated'),
  )
  await expect(
    log
      .getByRole('row')
      .filter({ hasText: t('admin.settings.fields.site.name.label') })
      .first(),
  ).toContainText(renamed)

  // 恢复站点名和公告
  const restored = await page.request.patch('/api/admin/settings', {
    data: { values: { 'site.name': original, 'site.announcement': '' } },
  })
  expect(restored.status()).toBe(200)
})
