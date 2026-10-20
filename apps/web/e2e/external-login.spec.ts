import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTranslator } from '@nextskin/i18n'
import { expect, test as base } from '@playwright/test'
import { nextskin } from './nextskin-cli'

const test = base.extend<object, { pluginHost: boolean }>({
  pluginHost: [false, { option: true, scope: 'worker' }],
})
const t = createTranslator('zh-CN')
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const messages = JSON.parse(readFileSync(join(repository, 'plugins/oauth-github/locales/zh-CN.json'), 'utf8')) as {
  plugin: { name: string }
  login: { github: string }
  settings: { clientId: { label: string }; clientSecret: { label: string } }
}
const name = messages.plugin.name
let packageDirectory: string | undefined
let packageFile: string | undefined
let restore: (() => Promise<void>) | undefined

test.use({ locale: 'zh-CN' })
test.beforeAll(({ pluginHost }) => {
  if (!pluginHost) return
  packageDirectory = mkdtempSync(join(tmpdir(), 'nextskin-e2e-external-login-'))
  const source = join(repository, 'plugins/oauth-github')
  for (const directory of ['src', 'locales'])
    cpSync(join(source, directory), join(packageDirectory, directory), { recursive: true })
  // 临时目录没有 workspace 依赖；让构建器把同一份 OAuth 共用库打入包中。
  const entry = join(packageDirectory, 'src/index.ts')
  writeFileSync(
    entry,
    readFileSync(entry, 'utf8').replace(
      "'@nextskin/oauth-client'",
      JSON.stringify(join(repository, 'packages/oauth-client/src/index.ts')),
    ),
  )
  // 构建命令按插件项目里装的 SDK 算 `api`
  mkdirSync(join(packageDirectory, 'node_modules/@nextskin'), { recursive: true })
  symlinkSync(
    join(repository, 'packages/plugin-sdk'),
    join(packageDirectory, 'node_modules/@nextskin/plugin-sdk'),
    'junction',
  )
  const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { version: string }
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: '@e2e/oauth-github', version, nextskin: { id: 'host-oauth-github' } }),
  )
  packageFile = join(packageDirectory, 'plugin.tgz')
  execFileSync(process.execPath, [
    join(repository, 'packages/plugin-cli/src/cli.ts'),
    'build',
    packageDirectory,
    '--out',
    packageFile,
  ])
})
test.afterEach(async () => {
  await restore?.()
  restore = undefined
})
test.afterAll(() => {
  if (packageDirectory) rmSync(packageDirectory, { recursive: true, force: true })
})

test('GitHub 登录：后台配置回调、登录按钮、授权参数和取消授权的提示', async ({
  page,
  browser,
  pluginHost,
  baseURL,
}) => {
  if (!baseURL) throw new Error('没有站点地址')
  const id = pluginHost ? 'host-oauth-github' : 'oauth-github'
  const suffix = String(Date.now()).slice(-7)
  const email = `oauth${suffix}@example.test`
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.170' })
  const registration = await page.request.post('/api/register', {
    data: { email, password: 'correct horse battery staple', playerName: `OAuth${suffix}` },
  })
  expect(registration.status()).toBe(201)
  const directory = pluginHost
    ? process.env.NEXTSKIN_E2E_PLUGINS_HOST_DATA_DIR
    : process.env.NEXTSKIN_E2E_PLUGINS_DATA_DIR
  nextskin(directory, 'set-role', email, 'superadmin')
  if (pluginHost) {
    if (!packageFile) throw new Error('没有打出 GitHub 插件包')
    await page.goto('/admin/plugins')
    await page.getByRole('button', { name: t('admin.plugins.upload.button') }).click()
    await page
      .getByRole('dialog', { name: t('admin.plugins.upload.button') })
      .locator('input[type=file]')
      .setInputFiles(packageFile)
    const dialog = page.getByRole('dialog', { name: t('admin.plugins.upload.installTitle', { name }) })
    await expect(dialog).toContainText(id)
    await dialog.getByRole('button', { name: t('admin.plugins.upload.confirmInstall'), exact: true }).click()
    await expect(page).toHaveURL(`/admin/plugins/${id}`)
  }
  // 即使用例中途失败，也停用并卸载安装插件，避免影响同一个服务的其他 spec。
  restore = async () => {
    expect((await page.request.post(`/api/admin/plugins/${id}/disable`)).status()).toBe(200)
    if (pluginHost) expect((await page.request.delete(`/api/admin/plugins/${id}`)).status()).toBe(200)
  }
  await page.goto(`/admin/plugins/${id}`)
  const callback = `${baseURL}/api/external-login/${id}/github/callback`
  await expect(page.getByText(callback, { exact: true })).toBeVisible()
  const settings = page.getByRole('form', { name: t('admin.plugins.settings.label', { name }) })
  await settings.getByLabel(messages.settings.clientId.label, { exact: true }).fill('e2e-github-client')
  const secretLabel = messages.settings.clientSecret.label
  // 上次失败留下设置时显示“已设置”，因此按字段名的前缀找密钥输入框。
  await settings.getByRole('textbox', { name: new RegExp(`^${secretLabel}`) }).fill('e2e-github-secret')
  await settings.getByRole('button', { name: t('admin.settings.save') }).click()
  await expect(page.getByText(t('admin.settings.saved', { count: 2 }))).toBeVisible()
  await page.getByRole('button', { name: t('admin.plugins.enable'), exact: true }).click()
  const enable = page.getByRole('alertdialog', { name: t('admin.plugins.enableTitle', { name }) })
  await enable.getByRole('button', { name: t('admin.plugins.enableConfirm'), exact: true }).click()
  await expect(page.getByText(t('admin.plugins.enabled', { name }))).toBeVisible()

  const visitorContext = await browser.newContext({ locale: 'zh-CN' })
  try {
    const visitor = await visitorContext.newPage()
    await visitor.goto(`${baseURL}/sign-in`)
    const button = visitor.getByRole('button', {
      name: t('auth.external.signIn', { provider: messages.login.github }),
      exact: true,
    })
    await expect(button).toBeVisible()
    // 拦下顶层导航，不向 GitHub 交换授权码；真实交换在请求级测试里覆盖。
    await visitor.route('https://github.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>GitHub authorization intercepted</p>' }),
    )
    const authorized = visitor.waitForRequest('https://github.com/**')
    await button.click()
    const url = new URL((await authorized).url())
    await visitor.waitForURL('https://github.com/**')
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('e2e-github-client')
    expect(url.searchParams.get('redirect_uri')).toBe(callback)
    const state = url.searchParams.get('state')
    expect(state).toBeTruthy()
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    await visitor.goto(callback + '?' + new URLSearchParams({ error: 'access_denied', state: state! }).toString())
    await expect(visitor).toHaveURL(`${baseURL}/sign-in?error=external_login_cancelled`)
    await expect(visitor.getByText(t('errors.external_login_cancelled'), { exact: true })).toBeVisible()
  } finally {
    await visitorContext.close()
  }

  await page.goto(`/admin/plugins/${id}`)
  await page.getByRole('button', { name: t('admin.plugins.disable'), exact: true }).click()
  const disable = page.getByRole('alertdialog', { name: t('admin.plugins.disableTitle', { name }) })
  await disable.getByRole('button', { name: t('admin.plugins.disableConfirm'), exact: true }).click()
  await expect(page.getByText(t('admin.plugins.disabled', { name }))).toBeVisible()
  if (pluginHost) {
    await page.getByRole('button', { name: t('admin.plugins.uninstall.button') }).click()
    const uninstall = page.getByRole('alertdialog', { name: t('admin.plugins.uninstall.dialogTitle', { name }) })
    await uninstall.getByRole('button', { name: t('admin.plugins.uninstall.confirm'), exact: true }).click()
    await expect(page).toHaveURL('/admin/plugins')
    await expect(page.locator(`a[href="/admin/plugins/${id}"]`)).toHaveCount(0)
  }
  restore = undefined
})
