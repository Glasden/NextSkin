import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTranslator } from '@nextskin/i18n'
import { expect, test, type Page } from '@playwright/test'

// 后台的主流程（ADR-0027）：举报 → 管理员删除材质 → 举报人看到已采纳 → 审计日志；封禁上传者 → 他只看到封禁说明，
// CSL 对他的角色返回 403。跑在 account 项目上：上传是 multipart 表单，接口按站点地址检查 Origin（playwright.config.ts）
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
