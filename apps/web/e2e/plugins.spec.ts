import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createTranslator } from '@nextskin/i18n'
import { expect, test as base, type Page } from '@playwright/test'
import { nextskin } from './nextskin-cli'

// 参考插件跑通（ADR-0033"验收：参考插件"）：后台启用、插件的设置、插件加的页面和导航、注册表单上的字段和
// 事务内的拦截器、核对导入的旧密码。跑两遍：plugins 项目里是随站点发布的官方插件，在核心进程内运行；plugins-host 项目里先用
// nextskin-plugin build 打成插件包、换个 id，从后台上传安装，在 plugin host 里运行，最后卸载。
// 各自跑在自己的服务上（playwright.config.ts）：启用邀请码之后注册都要填邀请码，和别的用例共用一个站点会让它们注册失败
const test = base.extend<object, { pluginHost: boolean }>({
  pluginHost: [false, { option: true, scope: 'worker' }],
})
const t = createTranslator('zh-CN')
const suffix = String(Date.now()).slice(-6)
const password = 'correct horse battery staple'

test.use({ locale: 'zh-CN' })

// 邀请码的用例中途失败时停用插件，不然同一个服务上后面的用例都注册不了
let restore: (() => Promise<unknown>) | undefined
test.afterEach(async () => {
  await restore?.()
  restore = undefined
})

type Messages = { [key: string]: string | Messages }

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const packages = new Map<string, string>()

/** 上传安装时插件的 id 前面加 `host-`：官方插件的 id 不能被上传的插件占用 */
const pluginId = (id: string, host: boolean) => (host ? `host-${id}` : id)

test.beforeAll(({ pluginHost }) => {
  if (!pluginHost) return
  // 和插件作者一样用 nextskin-plugin build 打包；只换 package.json 里的 id
  for (const id of ['invitation-codes', 'share-registration-link', 'cdn-refresh', 'authme-password']) {
    const dir = mkdtempSync(join(tmpdir(), `nextskin-e2e-${id}-`))
    const source = join(repository, 'plugins', id)
    cpSync(join(source, 'src'), join(dir, 'src'), { recursive: true })
    cpSync(join(source, 'locales'), join(dir, 'locales'), { recursive: true })
    // 构建命令按插件项目里装的 SDK 算 `api`
    mkdirSync(join(dir, 'node_modules', '@nextskin'), { recursive: true })
    symlinkSync(join(repository, 'packages/plugin-sdk'), join(dir, 'node_modules/@nextskin/plugin-sdk'), 'junction')
    const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { version: string }
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: `@e2e/${id}`, version, nextskin: { id: pluginId(id, true) } }),
    )
    const out = join(dir, 'plugin.tgz')
    execFileSync(process.execPath, [join(repository, 'packages/plugin-cli/src/cli.ts'), 'build', dir, '--out', out])
    packages.set(id, out)
  }
})

/** 插件自己的文案（不带参数的那些），和插件一起发布在 locales 目录里 */
function pluginText(id: string) {
  const messages = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../plugins/${id}/locales/zh-CN.json`, import.meta.url)), 'utf8'),
  ) as Messages
  return (key: string) => {
    const value = key
      .split('.')
      .reduce<string | Messages | undefined>(
        (node, part) => (typeof node === 'object' ? node[part] : undefined),
        messages,
      )
    if (typeof value !== 'string') throw new Error(`插件 ${id} 没有文案 ${key}`)
    return value
  }
}

async function register(page: Page, ip: string, name: string) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip })
  const email = `${name.toLowerCase()}@example.test`
  const response = await page.request.post('/api/register', { data: { email, password, playerName: name } })
  expect(response.status()).toBe(201)
  return email
}

/** 第一个超级管理员由命令行设定（ADR-0027），直接改这个服务的数据目录 */
function setRole(email: string, role: string, host: boolean) {
  const directory = host ? process.env.NEXTSKIN_E2E_PLUGINS_HOST_DATA_DIR : process.env.NEXTSKIN_E2E_PLUGINS_DATA_DIR
  nextskin(directory, 'set-role', email, role)
}

/** 从后台上传插件包：确认框里写着插件的名字和信任提示（要用高风险能力的还有 `highRisk`），装好之后到插件页，还没启用 */
async function upload(page: Page, id: string, name: string, highRisk?: string) {
  const file = packages.get(id)
  if (!file) throw new Error(`没有打出 ${id} 的插件包`)
  await page.goto('/admin/plugins')
  await page.getByRole('button', { name: t('admin.plugins.upload.button') }).click()
  await page
    .getByRole('dialog', { name: t('admin.plugins.upload.button') })
    .locator('input[type=file]')
    .setInputFiles(file)
  const confirm = page.getByRole('dialog', { name: t('admin.plugins.upload.installTitle', { name }) })
  await expect(confirm).toContainText(t('admin.plugins.upload.trust'))
  await expect(confirm).toContainText(pluginId(id, true))
  if (highRisk) await expect(confirm).toContainText(highRisk)
  await confirm.getByRole('button', { name: t('admin.plugins.upload.confirmInstall'), exact: true }).click()
  await expect(page.getByText(t('admin.plugins.upload.installedToast', { name }))).toBeVisible()
  await expect(page).toHaveURL(`/admin/plugins/${pluginId(id, true)}`)
  await expect(page.getByText(t('admin.plugins.installed'), { exact: true })).toBeVisible()
  await expect(page.getByText(t('admin.plugins.status.disabled'), { exact: true })).toBeVisible()
}

/** 这个服务的 SQLite 数据库（playwright.config.ts 给每个服务一个数据目录） */
function database(host: boolean) {
  const directory = host ? process.env.NEXTSKIN_E2E_PLUGINS_HOST_DATA_DIR : process.env.NEXTSKIN_E2E_PLUGINS_DATA_DIR
  if (!directory) throw new Error('没有插件服务的数据目录')
  const db = new DatabaseSync(join(directory, 'nextskin.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/** 用户的密码哈希；`hash` 不为空时先换成它，相当于导入器从 BS 写进来的值 */
function passwordHash(email: string, host: boolean, hash?: string): string {
  const db = database(host)
  try {
    const user = "(select id from users where email = ?) and provider_id = 'credential'"
    if (hash !== undefined) db.prepare(`update accounts set password = ? where user_id = ${user}`).run(hash, email)
    const row = db.prepare(`select password from accounts where user_id = ${user}`).get(email) as
      { password: string } | undefined
    if (!row) throw new Error(`${email} 没有密码`)
    return row.password
  } finally {
    db.close()
  }
}

const hex = (algorithm: string, value: string) => createHash(algorithm).update(value).digest('hex')

/** 在后台的插件页启用或停用一个插件，确认框里写着插件的名字 */
async function toggle(page: Page, id: string, name: string, action: 'enable' | 'disable') {
  await page.goto(`/admin/plugins/${id}`)
  await page.getByRole('button', { name: t(`admin.plugins.${action}`) }).click()
  const dialog = page.getByRole('alertdialog', { name: t(`admin.plugins.${action}Title`, { name }) })
  await dialog.getByRole('button', { name: t(`admin.plugins.${action}Confirm`), exact: true }).click()
  await expect(page.getByText(t(`admin.plugins.${action}d`, { name }))).toBeVisible()
  await expect(
    page.getByText(t(`admin.plugins.status.${action === 'enable' ? 'enabled' : 'disabled'}`), { exact: true }),
  ).toBeVisible()
}

test('邀请码：启用后注册要填邀请码，每个码只能用一次；停用后注册恢复原样', async ({ page, browser, pluginHost }) => {
  const ic = pluginText('invitation-codes')
  const name = ic('plugin.name')
  const id = pluginId('invitation-codes', pluginHost)
  const nav = page.getByRole('navigation', { name: t('admin.nav.label') })
  setRole(await register(page, '203.0.113.140', `Inv${suffix}`), 'superadmin', pluginHost)
  if (pluginHost) await upload(page, 'invitation-codes', name)

  // 插件列表里有它，没启用时后台导航里没有它的页面
  await page.goto('/admin/plugins')
  const list = page.getByRole('table', { name: t('admin.plugins.tableLabel') })
  // 上传安装的和官方的同名，按地址找
  await expect(list.locator(`a[href="/admin/plugins/${id}"]`)).toHaveText(name)
  await expect(nav.getByRole('link', { name: ic('page.codes') })).toHaveCount(0)
  expect((await page.request.get(`/admin/plugins/${id}/codes`)).status()).toBe(404)

  await toggle(page, id, name, 'enable')
  restore = () => page.request.post(`/api/admin/plugins/${id}/disable`)

  // 注册页多了邀请码一栏；不填就注册不了
  const visitorContext = await browser.newContext({ locale: 'zh-CN' })
  const visitor = await visitorContext.newPage()
  await visitor.context().setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.141' })
  const missing = await visitor.request.post('/api/register', {
    data: { email: `nocode${suffix}@example.test`, password, playerName: `NoCode${suffix}` },
  })
  expect(missing.status()).toBe(400)
  expect(((await missing.json()) as { error: { fields: Record<string, unknown> } }).error.fields).toHaveProperty([
    `${id}.code`,
  ])

  // 后台导航里的“邀请码”：生成两个
  await page.goto('/admin')
  await nav.getByRole('link', { name: ic('page.codes') }).click()
  await expect(page).toHaveURL(`/admin/plugins/${id}/codes`)
  const table = page.getByRole('table', { name: ic('page.codes') })
  await expect(table.getByText(t('pluginView.empty'))).toBeVisible()
  await page.getByRole('button', { name: ic('action.generate') }).click()
  const generate = page.getByRole('dialog', { name: ic('action.generate') })
  await generate.getByLabel(ic('field.count')).fill('2')
  await generate.getByRole('button', { name: ic('action.generate') }).click()
  await expect(page.getByText(t('pluginView.done'))).toBeVisible()
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await expect(page.getByText(t('pluginView.count', { count: 2 }))).toBeVisible()
  const [used, spare] = await table.locator('tbody code').allTextContents()
  if (!used || !spare) throw new Error('没有读到生成的邀请码')

  // 填错的码被插件拒绝，提示是插件写的；填对的注册成功，进入用户中心
  const visitorName = `Guest${suffix}`
  await visitor.goto('/sign-up')
  await visitor.getByLabel(t('auth.email')).fill(`${visitorName.toLowerCase()}@example.test`)
  await visitor.getByLabel(t('auth.password')).fill(password)
  await visitor.getByLabel(t('auth.signUp.playerName')).fill(visitorName)
  const codeInput = visitor.getByLabel(ic('field.code'))
  await expect(codeInput).toHaveAccessibleDescription(ic('field.codeHelp'))
  await codeInput.fill('NOT-A-REAL-CODE')
  await visitor.getByRole('button', { name: t('auth.signUp.submit') }).click()
  await expect(visitor.getByText(ic('error.invalidCode'))).toBeVisible()
  // 输入时大小写和分隔符随意，插件统一处理
  await codeInput.fill(used.toLowerCase().replace(/(.{4})(?=.)/g, '$1-'))
  await visitor.getByRole('button', { name: t('auth.signUp.submit') }).click()
  await visitor.waitForURL('/user')
  await visitorContext.close()

  // 用过的码标成已使用（拦截器里，随注册提交）；使用者由 user.registered 事件在提交之后写上，要等任务跑完
  const usedRow = table.getByRole('row').filter({ hasText: used })
  await expect(async () => {
    await page.reload()
    await expect(usedRow.getByText(ic('status.used'), { exact: true })).toBeVisible({ timeout: 1000 })
    await expect(usedRow.getByRole('link', { name: visitorName })).toBeVisible({ timeout: 1000 })
  }).toPass()

  // 同一个码不能再用：拦截器拒绝，整个注册回滚
  const again = await page.request.post('/api/register', {
    headers: { 'x-forwarded-for': '203.0.113.142' },
    data: {
      email: `again${suffix}@example.test`,
      password,
      playerName: `Again${suffix}`,
      plugins: { [id]: { code: used } },
    },
  })
  expect(again.status()).toBe(403)
  expect(await again.json()).toMatchObject({
    error: { code: 'registration_denied', plugin: id, reason: 'invalid_code' },
  })
  expect((await page.request.get(`/csl/Again${suffix}.json`)).status()).toBe(404)

  // 删掉没用过的码：先确认
  await page.getByRole('button', { name: `${ic('action.delete')} ${spare}` }).click()
  const confirm = page.getByRole('alertdialog', { name: ic('action.delete') })
  await expect(confirm).toContainText(ic('confirm.delete'))
  await confirm.getByRole('button', { name: ic('action.delete') }).click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table.getByText(spare)).toHaveCount(0)

  // 搜索是插件的路由处理的
  await page.getByRole('searchbox', { name: t('pluginView.searchLabel', { title: ic('page.codes') }) }).fill('ZZZZ')
  await page.getByRole('button', { name: t('pluginView.search') }).click()
  await expect(table.getByText(t('pluginView.emptySearch'))).toBeVisible()

  // 停用后注册不再要邀请码，导航里的页面也没了；启用和停用都记在审计日志里
  await toggle(page, id, name, 'disable')
  restore = undefined
  await expect(nav.getByRole('link', { name: ic('page.codes') })).toHaveCount(0)
  const laterContext = await browser.newContext({ locale: 'zh-CN' })
  await register(await laterContext.newPage(), '203.0.113.143', `After${suffix}`)
  await laterContext.close()
  await page.goto('/admin/audit')
  const log = page.getByRole('table', { name: t('admin.audit.tableLabel') })
  const rows = log
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: t('admin.audit.subjects.plugin', { name }), exact: true }) })
  await expect(rows.getByRole('cell', { name: t('admin.audit.actions.pluginEnable'), exact: true })).toBeVisible()
  await expect(rows.getByRole('cell', { name: t('admin.audit.actions.pluginDisable'), exact: true })).toBeVisible()
  if (!pluginHost) return

  // 卸载：先确认；插件从列表里消失，审计日志里记着安装和卸载
  await page.goto(`/admin/plugins/${id}`)
  await page.getByRole('button', { name: t('admin.plugins.uninstall.button') }).click()
  const uninstall = page.getByRole('alertdialog', { name: t('admin.plugins.uninstall.dialogTitle', { name }) })
  await uninstall.getByRole('button', { name: t('admin.plugins.uninstall.confirm'), exact: true }).click()
  await expect(page.getByText(t('admin.plugins.uninstall.done', { name }))).toBeVisible()
  await expect(page).toHaveURL('/admin/plugins')
  await expect(page.locator(`a[href="/admin/plugins/${id}"]`)).toHaveCount(0)
  expect((await page.request.get(`/admin/plugins/${id}`)).status()).toBe(404)
  await page.goto('/admin/audit')
  // 卸载之后插件不在了，审计记录的对象只写 id，不再是链接
  const gone = log.getByRole('row').filter({ hasText: t('admin.audit.subjects.plugin', { name: id }) })
  await expect(gone.getByRole('cell', { name: t('admin.audit.actions.pluginInstall'), exact: true })).toBeVisible()
  await expect(gone.getByRole('cell', { name: t('admin.audit.actions.pluginUninstall'), exact: true })).toBeVisible()
})

test('分享注册链接：经链接打开的注册页填好了分享码，注册之后双方的积分记录写着插件的原因', async ({
  page,
  browser,
  pluginHost,
}) => {
  const sr = pluginText('share-registration-link')
  const name = sr('plugin.name')
  const id = pluginId('share-registration-link', pluginHost)
  const history = (target: Page) => target.getByRole('region', { name: t('user.dashboard.history') })
  setRole(await register(page, '203.0.113.170', `Share${suffix}`), 'superadmin', pluginHost)
  if (pluginHost)
    await upload(
      page,
      'share-registration-link',
      name,
      t('admin.plugins.upload.highRisk', { list: t('admin.plugins.capabilities.users.score') }),
    )

  // 默认只给分享人加分，这里让新用户也得 10 分
  await page.goto(`/admin/plugins/${id}`)
  const settings = page.getByRole('form', { name: t('admin.plugins.settings.label', { name }) })
  await settings.getByLabel(sr('settings.shareeScore.label'), { exact: true }).fill('10')
  await settings.getByRole('button', { name: t('admin.settings.save') }).click()
  await expect(page.getByText(t('admin.settings.saved', { count: 1 }))).toBeVisible()
  await toggle(page, id, name, 'enable')
  restore = () => page.request.post(`/api/admin/plugins/${id}/disable`)

  // 用户中心的导航里多了插件的页面：生成一个链接，链接的参数是插件 id 加字段名
  await page.goto('/user')
  await page
    .getByRole('navigation', { name: t('user.nav.label') })
    .getByRole('link', { name: sr('page.links') })
    .click()
  await expect(page).toHaveURL(`/user/plugins/${id}/links`)
  const table = page.getByRole('table', { name: sr('page.links') })
  await expect(table.getByText(t('pluginView.empty'))).toBeVisible()
  await page.getByRole('button', { name: sr('action.generate') }).click()
  await expect(page.getByText(t('pluginView.done'))).toBeVisible()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  const link = new URL((await table.locator('tbody code').textContent()) ?? '')
  expect(link.pathname).toBe('/sign-up')
  const code = link.searchParams.get(`${id}.code`)
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{16}$/)

  // 访客打开链接：分享码已经填好，照常注册
  const visitorContext = await browser.newContext({ locale: 'zh-CN' })
  const visitor = await visitorContext.newPage()
  await visitor.context().setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.171' })
  await visitor.goto(`${link.pathname}${link.search}`)
  await expect(visitor.getByLabel(sr('field.code'))).toHaveValue(code!)
  const visitorName = `Shared${suffix}`
  await visitor.getByLabel(t('auth.email')).fill(`${visitorName.toLowerCase()}@example.test`)
  await visitor.getByLabel(t('auth.password')).fill(password)
  await visitor.getByLabel(t('auth.signUp.playerName')).fill(visitorName)
  await visitor.getByRole('button', { name: t('auth.signUp.submit') }).click()
  await visitor.waitForURL('/user')

  // 积分由 user.registered 事件在注册提交之后发，要等任务跑完；先给分享人、再给新用户
  await expect(async () => {
    await visitor.reload()
    await expect(history(visitor).getByText(sr('score.sharee'))).toBeVisible({ timeout: 1000 })
  }).toPass()
  await page.goto('/user')
  await expect(history(page).getByText(sr('score.sharer'))).toBeVisible()
  await page.goto(`/user/plugins/${id}/links`)
  await expect(table.getByRole('cell', { name: '1', exact: true })).toBeVisible()

  // 后台的插件详情页：累计加了 60 分，最近的记录里是这两笔
  await page.goto(`/admin/plugins/${id}`)
  await expect(page.getByText(t('admin.plugins.score.added'), { exact: true }).locator('..')).toContainText('60')
  const ledger = page.getByRole('table', { name: t('admin.plugins.score.tableLabel') })
  await expect(ledger.getByRole('cell', { name: sr('score.sharer'), exact: true })).toBeVisible()
  await expect(ledger.getByRole('cell', { name: sr('score.sharee'), exact: true })).toBeVisible()

  // 删掉链接：先确认
  await page.goto(`/user/plugins/${id}/links`)
  await page.getByRole('button', { name: new RegExp(`^${sr('action.delete')} `) }).click()
  const confirm = page.getByRole('alertdialog', { name: sr('action.delete') })
  await expect(confirm).toContainText(sr('confirm.delete'))
  await confirm.getByRole('button', { name: sr('action.delete') }).click()
  await expect(table.getByText(t('pluginView.empty'))).toBeVisible()

  await toggle(page, id, name, 'disable')
  restore = undefined
  if (!pluginHost) {
    await visitorContext.close()
    return
  }

  // 卸载之后翻译不了插件的原因，积分记录写"来自插件"和插件 id
  await page.goto(`/admin/plugins/${id}`)
  await page.getByRole('button', { name: t('admin.plugins.uninstall.button') }).click()
  const uninstall = page.getByRole('alertdialog', { name: t('admin.plugins.uninstall.dialogTitle', { name }) })
  await uninstall.getByRole('button', { name: t('admin.plugins.uninstall.confirm'), exact: true }).click()
  await expect(page.getByText(t('admin.plugins.uninstall.done', { name }))).toBeVisible()
  await visitor.reload()
  await expect(history(visitor).getByText(t('score.fromPlugin', { name: id }))).toBeVisible()
  await visitorContext.close()
})

test('CDN 刷新：设置里的密钥不回显；插件的表单页把插件给的错误显示出来', async ({ page, pluginHost }) => {
  const cdn = pluginText('cdn-refresh')
  const name = cdn('plugin.name')
  const id = pluginId('cdn-refresh', pluginHost)
  const secretValue = `e2e-secret-${suffix}`
  setRole(await register(page, '203.0.113.150', `Cdn${suffix}`), 'superadmin', pluginHost)
  if (pluginHost) await upload(page, 'cdn-refresh', name)

  // 设置：选服务商、填密钥；保存后密钥只显示“已设置”，页面里没有它的值
  await page.goto(`/admin/plugins/${id}`)
  const settings = page.getByRole('form', { name: t('admin.plugins.settings.label', { name }) })
  await settings.getByRole('combobox', { name: cdn('settings.provider.label') }).click()
  await page.getByRole('option', { name: cdn('settings.provider.options.tencent') }).click()
  await settings.getByLabel(cdn('settings.baseUrl.label')).fill('https://cdn.example.test')
  await settings.getByLabel(cdn('settings.accessKeyId.label'), { exact: true }).fill('AKIDexample')
  // 机密设置项的名字后面跟着“未设置”或“已设置”
  const secretLabel = cdn('settings.accessKeySecret.label')
  await settings
    .getByRole('textbox', { name: `${secretLabel} ${t('admin.settings.secret.unset')}`, exact: true })
    .fill(secretValue)
  await settings.getByRole('button', { name: t('admin.settings.save') }).click()
  await expect(page.getByText(t('admin.settings.saved', { count: 4 }))).toBeVisible()
  await page.reload()
  await expect(
    settings.getByRole('textbox', { name: `${secretLabel} ${t('admin.settings.secret.set')}`, exact: true }),
  ).toHaveValue('')
  await expect(settings.getByRole('combobox', { name: cdn('settings.provider.label') })).toHaveText(
    cdn('settings.provider.options.tencent'),
  )
  expect(await page.content()).not.toContain(secretValue)

  // 启用后后台导航里多了“刷新 CDN”；别的站点的地址被插件拒绝，错误显示在表单里，填写的内容还在
  await toggle(page, id, name, 'enable')
  await page
    .getByRole('navigation', { name: t('admin.nav.label') })
    .getByRole('link', { name: cdn('page.refresh') })
    .click()
  await expect(page.getByRole('heading', { name: cdn('page.refresh'), level: 1 })).toBeVisible()
  const paths = page.getByLabel(cdn('field.paths'))
  await paths.fill('https://elsewhere.example/csl/Steve.json')
  await page.getByRole('button', { name: cdn('action.refresh') }).click()
  await expect(page.getByText(t('pluginView.failed', { message: cdn('error.invalidPaths') }))).toBeVisible()
  await expect(paths).toHaveValue('https://elsewhere.example/csl/Steve.json')

  // 改设置记在审计日志里，一项一行，密钥只记“已更换”
  await page.goto('/admin/audit')
  const log = page.getByRole('table', { name: t('admin.audit.tableLabel') })
  const rows = log
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: t('admin.audit.subjects.plugin', { name }), exact: true }) })
  await expect(rows.getByRole('cell', { name: t('admin.audit.actions.pluginSettings'), exact: true })).toHaveCount(4)
  await expect(
    rows.getByRole('cell', {
      name: t('admin.audit.details.pluginSetting', {
        label: secretLabel,
        change: t('admin.audit.details.settingUpdate.secret'),
      }),
      exact: true,
    }),
  ).toBeVisible()
  expect(await page.content()).not.toContain(secretValue)
})

test('AuthMe 密码：导入的 AuthMe 哈希在启用插件后能登录，登录一次就换成站点自己的算法', async ({
  page,
  browser,
  pluginHost,
}) => {
  const am = pluginText('authme-password')
  const name = am('plugin.name')
  const id = pluginId('authme-password', pluginHost)
  const passwordHasher = t('admin.plugins.providers.passwordHasher')
  setRole(await register(page, '203.0.113.160', `Am${suffix}`), 'superadmin', pluginHost)
  if (pluginHost)
    await upload(page, 'authme-password', name, t('admin.plugins.upload.highRisk', { list: passwordHasher }))

  // 两个从 BS 导入的用户：一个是 SHA256 下 AuthMe 的哈希，一个是 SALTED2MD5 下带独立盐、由导入器打包的哈希
  const old = `authme old ${suffix}`
  const imported = async (ip: string, playerName: string, hash: string) => {
    const context = await browser.newContext({ locale: 'zh-CN' })
    const email = await register(await context.newPage(), ip, playerName)
    await context.close()
    passwordHash(email, pluginHost, hash)
    return email
  }
  const salt = '0123456789abcdef'
  const webEmail = await imported(
    '203.0.113.161',
    `AmWeb${suffix}`,
    `$SHA$${salt}$${hex('sha256', hex('sha256', old) + salt)}`,
  )
  const launcherEmail = await imported(
    '203.0.113.162',
    `AmLa${suffix}`,
    `$authme$salted2md5$a1b2c3$${hex('md5', hex('md5', old) + 'a1b2c3')}`,
  )

  // 插件页列出它提供的功能，标着高风险
  await page.goto(`/admin/plugins/${id}`)
  await expect(
    page.getByText(t('admin.plugins.manifest.providerItem', { kind: passwordHasher, label: am('hasher.authme') })),
  ).toBeVisible()

  // 没启用时旧密码登录不了
  const visitorContext = await browser.newContext({ locale: 'zh-CN' })
  const visitor = await visitorContext.newPage()
  await visitor.goto('/sign-in')
  await visitor.getByLabel(t('auth.email')).fill(webEmail)
  await visitor.getByLabel(t('auth.password')).fill(old)
  await visitor.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
  await expect(visitor.getByText(t('auth.signIn.invalidCredentials'))).toBeVisible()

  // 启用后能登录；登录之后库里换成了站点自己的算法
  await toggle(page, id, name, 'enable')
  await visitor.getByLabel(t('auth.password')).fill(old)
  await visitor.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
  await visitor.waitForURL('/user')
  await visitorContext.close()
  expect(passwordHash(webEmail, pluginHost)).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)

  // 启动器登录同样经过插件，令牌照常签发
  const authenticated = await page.request.post('/api/yggdrasil/authserver/authenticate', {
    data: { username: launcherEmail, password: old },
  })
  expect(authenticated.status()).toBe(200)
  expect(passwordHash(launcherEmail, pluginHost)).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
})
