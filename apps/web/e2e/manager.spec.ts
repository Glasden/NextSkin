import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTranslator } from '@nextskin/i18n'
import { expect, test } from './fixtures'
import { nextskinInstance } from './nextskin-cli'

const t = createTranslator('zh-CN')
const bundle = fileURLToPath(new URL('../../../dist/nextskin/', import.meta.url))
const version = readFileSync(join(bundle, 'manager/VERSION'), 'utf8').trim()
test.use({ locale: 'zh-CN' })

test('管理实例：后台、命令行和指针报告同一个版本；发行目录不留下运行状态', async ({ page }) => {
  const instance = process.env.NEXTSKIN_E2E_MANAGER_DIR
  if (!instance) throw new Error('没有管理实例目录')
  const entry = join(instance, 'nextskin.mjs')
  const name = `Mgr${String(Date.now()).slice(-6)}`
  const email = `${name.toLowerCase()}@example.test`
  const password = 'correct horse battery staple'
  const registered = await page.request.post('/api/register', { data: { email, password, playerName: name } })
  expect(registered.status()).toBe(201)
  nextskinInstance(entry, 'set-role', email, 'superadmin')

  await page.context().clearCookies()
  await page.goto('/sign-in?next=%2Fadmin%2Fupdates')
  await page.getByLabel(t('auth.email')).fill(email)
  await page.getByLabel(t('auth.password')).fill(password)
  await page.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
  await expect(page).toHaveURL('/admin/updates')
  await expect(page.getByRole('heading', { name: t('admin.updates.oneClickTitle'), exact: true })).toBeVisible()

  const status = await page.request.get('/api/admin/updates')
  expect(status.status()).toBe(200)
  expect(await status.json()).toMatchObject({
    deployment: 'bundle',
    current: version,
    manager: { available: true, current: version, writable: true, rollback: null },
  })
  const releases = JSON.parse(nextskinInstance(entry, 'releases', '--json')) as { releases: unknown[] }
  expect(releases).toMatchObject({
    running: true,
    releases: [{ version, current: true }],
  })
  expect(releases.releases).toHaveLength(1)
  expect(JSON.parse(nextskinInstance(entry, 'update', 'status', '--json')) as unknown).toMatchObject({
    current: version,
    operation: null,
  })
  expect(JSON.parse(readFileSync(join(instance, 'releases/current.json'), 'utf8')) as unknown).toMatchObject({
    current: version,
    bundled: version,
  })
  // 只检查存在和权限，不读取或输出控制令牌（不变量 11）。
  const token = statSync(join(instance, 'releases/manager.token'))
  expect(token.isFile()).toBe(true)
  if (process.platform !== 'win32') expect(token.mode & 0o777).toBe(0o600)

  // 六个共用发行目录的服务已全部启动；它们若误走管理进程，锁和指针此时就已经污染 releases/。
  const entries = readdirSync(join(bundle, 'releases'))
  expect(
    entries.filter((entry) => entry !== version),
    `发行目录出现运行文件：${entries.join(', ')}`,
  ).toEqual([])
  expect(entries).toEqual([version])
})
