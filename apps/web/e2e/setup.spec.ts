import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from '@nextskin/i18n'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { OLD_SITE, OLD_SITE_PASSWORD } from '../../../packages/importer/src/testing/old-site.ts'

// 安装向导的两条路（ADR-0031）：新站，和从 BS 导入。两个服务都是未初始化的站点（playwright.config.ts），
// 导入那条的旧站是按 BS 表结构建的 SQLite 文件，里面故意留了一处 UUID 冲突
const t = createTranslator('zh-CN')

test.use({ locale: 'zh-CN' })

function setupCode(dataDirectory: string): string {
  return readFileSync(join(dataDirectory, 'setup-code'), 'utf8').trim()
}

async function enterCode(page: Page, dataDirectory: string) {
  await page.goto('/setup')
  // 安装码不对：留在这一步，告诉服主去哪里找
  await page.getByLabel(t('setup.code.label')).fill('AAAA-BBBB-CCCC-DDDD')
  await page.getByRole('button', { name: t('setup.code.submit') }).click()
  await expect(page.getByText(t('errors.setup_code_invalid'))).toBeVisible()
  // 大小写和连字符不影响
  await page.getByLabel(t('setup.code.label')).fill(setupCode(dataDirectory).toLowerCase())
  await page.getByRole('button', { name: t('setup.code.submit') }).click()
  await expect(page.getByRole('heading', { name: t('setup.paths.new.title') })).toBeVisible()
}

test.describe('新站', () => {
  const dataDirectory = process.env.NEXTSKIN_E2E_SETUP_NEW_DATA_DIR!
  test.use({ baseURL: 'http://localhost:3102' })

  test('输入安装码，创建第一个超级管理员，直接进后台；之后 /setup 是 404，安装码文件被删除', async ({ page }) => {
    // 没有安装码的 Cookie，接口一律拒绝
    const denied = await page.request.post('/api/setup/site', {
      data: { siteName: 'x', siteUrl: 'http://localhost:3102', email: 'a@example.test', nickname: 'a', password: 'x' },
    })
    expect(denied.status()).toBe(401)
    // 安装之前不开放注册：先注册的人会让向导关闭，站点就没有超级管理员了
    const registered = await page.request.post('/api/register', {
      data: { email: 'early@example.test', password: 'correct horse battery staple', playerName: 'Early' },
    })
    expect(registered.status()).toBe(403)
    expect(((await registered.json()) as { error: { code: string } }).error.code).toBe('setup_required')

    await enterCode(page, dataDirectory)
    await page.getByRole('button', { name: t('setup.paths.new.action') }).click()
    await page.getByLabel(t('setup.newSite.siteName')).fill('像素皮肤站')
    await page.getByLabel(t('setup.newSite.email')).fill('admin@example.test')
    await page.getByLabel(t('setup.newSite.nickname')).fill('站长')
    await page.getByLabel(t('setup.newSite.password')).fill('correct horse battery staple')
    await page.getByRole('button', { name: t('setup.newSite.submit') }).click()

    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole('heading', { name: t('admin.overview.title'), level: 1 })).toBeVisible()
    await expect(page.getByRole('link', { name: '像素皮肤站' })).toBeVisible()
    // 超级管理员才有“数据迁移”
    await expect(page.getByRole('link', { name: t('admin.nav.migration') })).toBeVisible()

    expect((await page.goto('/setup'))?.status()).toBe(404)
    expect((await page.request.post('/api/setup/code', { data: { code: 'x' } })).status()).toBe(404)
    expect(existsSync(join(dataDirectory, 'setup-code'))).toBe(false)
  })
})

test.describe('从 BS 导入', () => {
  const dataDirectory = process.env.NEXTSKIN_E2E_SETUP_IMPORT_DATA_DIR!
  const oldSite = process.env.NEXTSKIN_E2E_OLD_SITE_DIR!
  test.use({ baseURL: 'http://localhost:3103' })

  test('试跑发现 UUID 冲突，选好之后重新试跑、导入，用旧站的账号登录，UUID 是选的那个', async ({ page }) => {
    test.setTimeout(120_000)
    await enterCode(page, dataDirectory)
    await page.getByRole('button', { name: t('setup.paths.import.action') }).click()

    // 旧站的 .env：从里面读出连接、密码算法、盐和材质目录
    await page.getByLabel(t('import.wizard.env.paste')).fill(readFileSync(join(oldSite, '.env'), 'utf8'))
    await page.getByRole('button', { name: t('import.wizard.env.read') }).click()
    await expect(page.getByLabel(t('import.source.file'))).toHaveValue(join(oldSite, 'database.sqlite'))
    await page.getByRole('button', { name: t('import.wizard.source.check'), exact: true }).click()
    await expect(page.getByText(t('import.check.databaseOk', { version: '6.0.2' }))).toBeVisible()
    await expect(page.getByText(t('import.check.texturesOk'))).toBeVisible()
    await page.getByRole('button', { name: t('import.wizard.source.next') }).click()

    // 第一次试跑：Alex 在 uuid 表里有两个值，停下来让服主选
    await page.getByRole('button', { name: t('import.wizard.dryRun.start') }).click()
    await expect(page.getByRole('heading', { name: t('import.result.titles.blocked') })).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByText(t('import.report.issues.uuidAmbiguous', { name: 'Alex', pid: 2 }))).toBeVisible()
    await page.getByRole('combobox', { name: t('import.report.choice.label', { name: 'Alex' }) }).click()
    await page.getByRole('option', { name: OLD_SITE.alexUuids[0] }).click()

    // 第二次试跑通过，确认之后导入
    await page.getByRole('button', { name: t('import.wizard.dryRun.again') }).click()
    await expect(page.getByRole('heading', { name: t('import.result.dryRunSucceeded') })).toBeVisible({
      timeout: 60_000,
    })
    await page.getByRole('button', { name: t('import.wizard.dryRun.next') }).click()
    await expect(page.getByLabel(t('import.wizard.confirm.siteUrl'))).toHaveValue('http://localhost:3103')
    await page.getByRole('button', { name: t('import.wizard.confirm.start') }).click()
    await expect(page.getByRole('heading', { name: t('import.result.importSucceeded') })).toBeVisible({
      timeout: 60_000,
    })
    // 报告可以下载，认的是运行令牌的 Cookie
    const markdown = await page.request.get('/api/import/run/report.md')
    expect(markdown.status()).toBe(200)
    expect(await markdown.text()).toContain('Alex')

    // 站点初始化了：向导关闭，安装码删除
    expect((await page.request.get('/setup')).status()).toBe(404)
    expect(existsSync(join(dataDirectory, 'setup-code'))).toBe(false)

    // 用旧站的账号登录
    await page.getByRole('link', { name: t('import.result.signInAction') }).click()
    await page.getByLabel(t('auth.email')).fill(OLD_SITE.owner.email)
    await page.getByLabel(t('auth.password')).fill(OLD_SITE_PASSWORD)
    await page.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
    await expect(page).toHaveURL(/\/user$/)

    // 角色的 UUID：Steve 来自映射表，Alex 是试跑时选的那个（不变量 2）
    const profiles = await page.request.post('/api/yggdrasil/api/profiles/minecraft', { data: ['Steve', 'Alex'] })
    expect(await profiles.json()).toEqual(
      expect.arrayContaining([
        { id: OLD_SITE.steveUuid, name: 'Steve' },
        { id: OLD_SITE.alexUuids[0], name: 'Alex' },
      ]),
    )

    // 旧站的超级管理员在后台看得到这几次运行和报告
    await page.goto('/admin/migration')
    await expect(page.getByRole('heading', { name: t('admin.migration.title'), level: 1 })).toBeVisible()
    await expect(page.getByRole('table', { name: t('admin.migration.tableLabel') }).getByRole('row')).toHaveCount(4)
  })
})
