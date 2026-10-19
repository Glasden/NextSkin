import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTranslator } from '@nextskin/i18n'
import { expect, test, type Page } from '@playwright/test'

// 后台的主流程（ADR-0027）：举报 → 管理员删除材质 → 举报人看到已采纳 → 审计日志；封禁上传者 → 他只看到封禁说明，
// CSL 对他的角色返回 403。设置页（ADR-0028）：只有超级管理员能进，改了立即生效。
// 用户详情页（ADR-0036）：替丢了验证器的用户关掉两步验证、重设密码；角色页：改名、换材质、转让、删除。
// 跑在 account 项目上：上传是 multipart 表单，接口按站点地址检查 Origin（playwright.config.ts）。
// 两个用例放在同一个文件里按顺序跑：第一个按条数检查审计日志，另一个文件并行任命管理员会打乱它
const t = createTranslator('zh-CN')
const suffix = String(Date.now()).slice(-6)
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../packages/skin/test/fixtures/${name}.png`, import.meta.url))

test.use({ locale: 'zh-CN' })

const password = 'correct horse battery staple'

async function register(page: Page, ip: string, name: string) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip })
  const email = `${name.toLowerCase()}@example.test`
  const response = await page.request.post('/api/register', { data: { email, password, playerName: name } })
  expect(response.status()).toBe(201)
  return email
}

/** RFC 6238 的六位验证码，同 account.spec.ts */
function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = [...secret.toUpperCase().replace(/[\s=]/g, '')]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, '0'))
    .join('')
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const hmac = createHmac('sha1', key).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0xf
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

async function signIn(page: Page, email: string, secret: string, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  await page.getByLabel(t('auth.email')).fill(email)
  await page.getByLabel(t('auth.password')).fill(secret)
  await page.getByRole('button', { name: t('auth.signIn.submit'), exact: true }).click()
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

test('用户丢了验证器：管理员关掉两步验证，用户只用密码登录；管理员重设密码，用户原来的会话被退出', async ({
  page,
  browser,
}) => {
  // 用户开启两步验证
  const userContext = await browser.newContext({ locale: 'zh-CN' })
  const user = await userContext.newPage()
  const name = `Lost${suffix}`
  const email = await register(user, '203.0.113.122', name)
  await user.goto('/user/security')
  await user.getByRole('button', { name: t('user.security.twoFactor.enable') }).click()
  const enable = user.getByRole('dialog', { name: t('user.security.twoFactor.enable') })
  await enable.getByLabel(t('user.security.password.current')).fill(password)
  await enable.getByRole('button', { name: t('user.security.twoFactor.continue') }).click()
  const secret = (await enable.locator('code').textContent())!
  await enable.getByLabel(t('user.security.twoFactor.code')).fill(totp(secret))
  await enable.getByRole('button', { name: t('user.security.twoFactor.verify') }).click()
  await enable.getByRole('button', { name: t('user.security.twoFactor.done') }).click()
  await expect(user.getByText(t('user.security.twoFactor.enabled'))).toBeVisible()

  // 手机丢了：退出之后，密码对了也卡在第二步
  await user.getByRole('button', { name }).click()
  await user.getByRole('menuitem', { name: t('user.menu.signOut') }).click()
  await expect(user).toHaveURL('/sign-in')
  await signIn(user, email, password, '/user/security')
  await expect(user).toHaveURL(/\/sign-in\/two-factor/)

  // 管理员从用户列表进详情页，关掉两步验证
  setRole(await register(page, '203.0.113.123', `Sup${suffix}`), 'superadmin')
  await page.goto(`/admin/users?q=${encodeURIComponent(email)}`)
  await page.getByRole('link', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  const security = page.getByRole('region', { name: t('admin.userDetail.security.title') })
  await security.getByRole('button', { name: t('admin.userDetail.security.disableTwoFactor') }).click()
  await page
    .getByRole('alertdialog', { name: t('admin.userDetail.security.disableTwoFactorTitle', { nickname: name }) })
    .getByRole('button', { name: t('admin.userDetail.security.disableTwoFactor') })
    .click()
  await expect(page.getByText(t('admin.userDetail.security.twoFactorDisabled', { nickname: name }))).toBeVisible()
  await expect(security.getByText(t('admin.userDetail.security.off'), { exact: true })).toBeVisible()

  // 用户只用密码就能登录
  await signIn(user, email, password, '/user/security')
  await expect(user).toHaveURL('/user/security')
  await expect(user.getByRole('button', { name: t('user.security.twoFactor.enable') })).toBeVisible()

  // 管理员重设密码：用户刚登录的那个会话被退出
  const newPassword = `brand new passphrase ${suffix}`
  await security.getByRole('button', { name: t('admin.userDetail.security.setPassword') }).click()
  const reset = page.getByRole('alertdialog', {
    name: t('admin.userDetail.security.passwordTitle', { nickname: name }),
  })
  await reset.getByLabel(t('admin.userDetail.security.password')).fill(newPassword)
  await reset.getByRole('button', { name: t('admin.userDetail.security.passwordConfirm') }).click()
  await expect(page.getByText(t('admin.userDetail.security.passwordChanged', { sessions: 1, tokens: 0 }))).toBeVisible()
  await user.reload()
  await expect(user).toHaveURL(/\/sign-in/)

  // 旧密码不能再用，新密码可以。前面已经登录过两次，Better Auth 的登录限流是同一 IP 10 秒 3 次，换个 IP
  await userContext.setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.124' })
  await signIn(user, email, password, '/user')
  await expect(user.getByText(t('auth.signIn.invalidCredentials'))).toBeVisible()
  await signIn(user, email, newPassword, '/user')
  await expect(user).toHaveURL('/user')
  await userContext.close()

  // 详情页的审计节记下了这两项
  await page.reload()
  const audit = page.getByRole('table', { name: t('admin.userDetail.audit.tableLabel') })
  await expect(
    audit.getByRole('cell', { name: t('admin.audit.actions.userDisableTwoFactor'), exact: true }),
  ).toBeVisible()
  await expect(audit.getByRole('cell', { name: t('admin.audit.actions.userSetPassword'), exact: true })).toBeVisible()
})

test('角色页：从用户详情页进来，改名、设上主人的私有皮肤、转给别人时清掉它，最后删除；审计都记在主人名下', async ({
  page,
  browser,
  baseURL,
}) => {
  // 原主人传一张私有皮肤、一张公开披风，新主人只注册
  const ownerContext = await browser.newContext({ locale: 'zh-CN' })
  const owner = await ownerContext.newPage()
  const ownerName = `Orig${suffix}`
  const ownerEmail = await register(owner, '203.0.113.130', ownerName)
  const textureName = `私藏 ${suffix}`
  const uploaded = await owner.request.post('/api/textures', {
    headers: { Origin: new URL(baseURL!).origin },
    multipart: {
      file: { name: 'deadmau5.png', mimeType: 'image/png', buffer: readFileSync(fixture('deadmau5')) },
      name: textureName,
      type: 'steve',
      public: 'false',
    },
  })
  expect(uploaded.status()).toBe(201)
  const { texture } = (await uploaded.json()) as { texture: { tid: number; hash: string } }
  const capeUploaded = await owner.request.post('/api/textures', {
    headers: { Origin: new URL(baseURL!).origin },
    multipart: {
      file: { name: 'mojang_cape.png', mimeType: 'image/png', buffer: readFileSync(fixture('mojang_cape')) },
      name: `披风 ${suffix}`,
      type: 'cape',
      public: 'true',
    },
  })
  expect(capeUploaded.status()).toBe(201)
  const { texture: cape } = (await capeUploaded.json()) as { texture: { tid: number; hash: string } }
  await ownerContext.close()
  const recipientContext = await browser.newContext({ locale: 'zh-CN' })
  const recipientName = `New${suffix}`
  const recipientEmail = await register(await recipientContext.newPage(), '203.0.113.131', recipientName)
  await recipientContext.close()

  // 管理员从用户详情页的角色一节进角色页，只列出这个用户的角色
  setRole(await register(page, '203.0.113.132', `Pm${suffix}`), 'superadmin')
  await page.goto(`/admin/users?q=${encodeURIComponent(ownerEmail)}`)
  await page.getByRole('link', { name: ownerName, exact: true }).click()
  await page
    .getByRole('region', { name: t('admin.userDetail.players.title'), exact: true })
    .getByRole('link', { name: t('admin.userDetail.players.manage') })
    .click()
  await expect(page.getByText(t('admin.players.ownerFilter', { nickname: ownerName }))).toBeVisible()
  const table = page.getByRole('table', { name: t('admin.players.tableLabel') })
  await expect(table.getByRole('link', { name: ownerName, exact: true })).toBeVisible()
  const manage = (name: string) => page.getByRole('button', { name: t('admin.players.manageLabel', { name }) })

  // 改名：UUID 不变，CSL 跟着新名字走
  const renamed = `Moved${suffix}`
  await manage(ownerName).click()
  await page.getByRole('menuitem', { name: t('admin.players.rename') }).click()
  const rename = page.getByRole('dialog', { name: t('admin.players.renameTitle', { name: ownerName }) })
  await rename.getByLabel(t('admin.players.renameLabel')).fill(renamed)
  await rename.getByRole('button', { name: t('admin.players.renameConfirm') }).click()
  await expect(page.getByText(t('admin.players.renamed', { name: renamed }))).toBeVisible()
  expect((await page.request.get(`/csl/${ownerName}.json`)).status()).toBe(404)
  expect((await page.request.get(`/csl/${renamed}.json`)).status()).toBe(200)

  // 换材质：主人自己的私有皮肤可以设，不要求在衣柜里；预览按编号查出名字
  await manage(renamed).click()
  await page.getByRole('menuitem', { name: t('admin.players.textures') }).click()
  const textures = page.getByRole('dialog', { name: t('admin.players.texturesTitle', { name: renamed }) })
  await textures.getByLabel(t('admin.players.skinLabel')).fill(String(texture.tid))
  await expect(textures.getByText(textureName)).toBeVisible()
  await textures.getByLabel(t('admin.players.capeLabel')).fill(String(cape.tid))
  await expect(textures.getByText(`披风 ${suffix}`)).toBeVisible()
  await textures.getByRole('button', { name: t('admin.players.texturesConfirm') }).click()
  await expect(page.getByText(t('admin.players.texturesChanged', { name: renamed }))).toBeVisible()
  await expect(table.getByRole('link', { name: t('admin.players.skinLink', { tid: texture.tid }) })).toBeVisible()
  type Csl = { skins: Record<string, string | null>; cape: string | null }
  const csl = (await (await page.request.get(`/csl/${renamed}.json`)).json()) as Csl
  expect(Object.values(csl.skins)).toContain(texture.hash)
  expect(csl.cape).toBe(cape.hash)
  const { id: uuid } = (await (
    await page.request.get(`/api/yggdrasil/api/users/profiles/minecraft/${renamed}`)
  ).json()) as { id: string }

  // 转让：按邮箱查到新主人，确认框列出会清掉的私有皮肤；转让之后皮肤槽空了，主人换了
  await manage(renamed).click()
  await page.getByRole('menuitem', { name: t('admin.players.transfer') }).click()
  const transfer = page.getByRole('alertdialog', { name: t('admin.players.transferTitle', { name: renamed }) })
  const confirm = transfer.getByRole('button', { name: t('admin.players.transferConfirm') })
  await expect(confirm).toBeDisabled()
  await transfer.getByLabel(t('admin.players.recipientLabel')).fill(recipientEmail)
  await transfer.getByRole('button', { name: t('admin.players.lookup') }).click()
  await expect(transfer.getByText(recipientEmail)).toBeVisible()
  await expect(
    transfer.getByText(
      t('admin.players.texturesCleared', {
        items: t('admin.players.clearedItemNamed', { slot: 'skin', name: textureName }),
      }),
    ),
  ).toBeVisible()
  await confirm.click()
  await expect(page.getByText(t('admin.players.transferred', { name: renamed, nickname: recipientName }))).toBeVisible()
  await page.goto(`/admin/players?q=${encodeURIComponent(renamed.toLowerCase())}`)
  await expect(table.getByRole('link', { name: recipientName, exact: true })).toBeVisible()
  await expect(table.getByRole('link', { name: t('admin.players.skinLink', { tid: texture.tid }) })).toHaveCount(0)
  await expect(table.getByRole('link', { name: t('admin.players.capeLink', { tid: cape.tid }) })).toBeVisible()

  // 按 UUID 查档案仍是同一个 UUID，CSL 照常返回公开的披风，新主人在自己的角色页看到它
  const profile = await page.request.get(`/api/yggdrasil/sessionserver/session/minecraft/profile/${uuid}`)
  expect(await profile.json()).toMatchObject({ id: uuid, name: renamed })
  const moved = (await (await page.request.get(`/csl/${renamed}.json`)).json()) as Csl
  expect(moved.skins).toEqual({ default: null })
  expect(moved.cape).toBe(cape.hash)
  const recipientPage = await (await browser.newContext({ locale: 'zh-CN' })).newPage()
  await signIn(recipientPage, recipientEmail, password, '/user/players')
  await expect(recipientPage.getByText(renamed, { exact: true })).toBeVisible()
  await recipientPage.context().close()

  // 删除：确认框写明 UUID 会失效；之后 CSL 查不到
  await manage(renamed).click()
  await page.getByRole('menuitem', { name: t('admin.players.delete') }).click()
  const remove = page.getByRole('alertdialog', { name: t('admin.players.deleteTitle', { name: renamed }) })
  await expect(remove).toContainText(t('admin.players.deleteHint'))
  await remove.getByRole('button', { name: t('admin.players.deleteConfirm') }).click()
  await expect(page.getByText(t('admin.players.deleted', { name: renamed }))).toBeVisible()
  await expect(table.getByText(t('admin.players.emptyFiltered'))).toBeVisible()
  expect((await page.request.get(`/csl/${renamed}.json`)).status()).toBe(404)

  // 改名、换材质、转让记在原主人名下，转让和删除记在新主人名下
  await page.goto(`/admin/users?q=${encodeURIComponent(recipientEmail)}`)
  await page.getByRole('link', { name: recipientName, exact: true }).click()
  const audit = page.getByRole('table', { name: t('admin.userDetail.audit.tableLabel') })
  await expect(audit.getByRole('cell', { name: t('admin.audit.actions.playerTransfer'), exact: true })).toBeVisible()
  await expect(audit.getByRole('cell', { name: t('admin.audit.actions.playerDelete'), exact: true })).toBeVisible()
})
