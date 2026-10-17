import { createTranslator } from '@nextskin/i18n'
import { expect, test } from '@playwright/test'

// 用户中心经过 standalone 产物的主流程（ADR-0022）。播种数据的站点地址和浏览器的 Origin 不同（auth-pages.spec.ts），
// 所以账号用 /api/register 注册；页面的写请求都带 JSON 的 Content-Type，不按 Origin 拦。
// 同一 IP 最多注册 3 个账号：用自己的 TEST-NET 地址，不和其他用例共用
test.use({ locale: 'zh-CN', extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.60' } })

const t = createTranslator('zh-CN')
const suffix = String(Date.now()).slice(-6)

test('没有登录时跳到登录页，登录后回到原来的页面；next 只接受站内路径', async ({ page }) => {
  await page.goto('/user/players')
  await expect(page).toHaveURL('/sign-in?next=%2Fuser%2Fplayers')
  const register = await page.request.post('/api/register', {
    data: {
      email: `center-next-${suffix}@example.test`,
      password: 'correct horse battery staple',
      playerName: `Nx${suffix}`,
    },
  })
  expect(register.status()).toBe(201)
  // 已登录时打开登录页，直接去 next
  await page.goto('/sign-in?next=%2Fuser%2Fplayers')
  await expect(page).toHaveURL('/user/players')
  for (const next of ['//evil.test', '/\\evil.test', 'https://evil.test', '/\t/evil.test']) {
    await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
    await expect(page).toHaveURL('/user')
  }
})

test('签到，添加、改名、删除角色', async ({ page }) => {
  const name = `Ce${suffix}`
  const register = await page.request.post('/api/register', {
    data: { email: `center-${suffix}@example.test`, password: 'correct horse battery staple', playerName: name },
  })
  expect(register.status()).toBe(201)

  await page.goto('/user')
  await expect(page.getByRole('heading', { level: 1, name: t('user.dashboard.title') })).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: t('user.nav.label') }).getByRole('link', { name: t('user.nav.dashboard') }),
  ).toHaveAttribute('aria-current', 'page')
  // 注册时一起创建的角色站在展台上
  await expect(page.getByRole('img', { name: t('user.players.figureEmpty', { name }) })).toBeVisible()
  await page.getByRole('button', { name: t('user.dashboard.checkIn') }).click()
  await expect(page.getByText(/^签到成功，得到 \d+ 积分$/)).toBeVisible()
  await expect(page.getByRole('button', { name: t('user.dashboard.checkedIn') })).toBeDisabled()
  await expect(page.getByText(t('score.reasons.checkIn'), { exact: true })).toBeVisible()

  await page
    .getByRole('navigation', { name: t('user.nav.label') })
    .getByRole('link', { name: t('user.nav.players') })
    .click()
  await expect(page).toHaveURL('/user/players')
  await page.getByRole('button', { name: t('user.players.add') }).click()
  const dialog = page.getByRole('dialog', { name: t('user.players.add') })
  // 名字被占用：错误显示在输入框下方，对话框不关
  await dialog.getByLabel(t('user.players.name')).fill(name.toLowerCase())
  await dialog.getByRole('button', { name: t('user.players.add') }).click()
  await expect(dialog.getByLabel(t('user.players.name'))).toHaveAccessibleDescription(
    new RegExp(t('errors.player_name_taken')),
  )
  const added = `Ad${suffix}`
  await dialog.getByLabel(t('user.players.name')).fill(added)
  await dialog.getByRole('button', { name: t('user.players.add') }).click()
  await expect(page.getByText(t('user.players.added', { name: added }))).toBeVisible()
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: added }) })
  await expect(card).toBeVisible()
  const uuid = await card.locator('code').textContent()

  const renamed = `Rn${suffix}`
  await card.getByRole('button', { name: t('user.players.rename') }).click()
  const rename = page.getByRole('dialog', { name: t('user.players.renameTitle', { name: added }) })
  await rename.getByLabel(t('user.players.name')).fill(renamed)
  await rename.getByRole('button', { name: t('user.players.rename') }).click()
  await expect(page.getByText(t('user.players.renamed', { previous: added, name: renamed }))).toBeVisible()
  const renamedCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: renamed }) })
  // 改名不改 UUID（不变量 2）
  await expect(renamedCard.locator('code')).toHaveText(uuid!)

  // 删除走没有请求体的 DELETE，经过 Next 的 Route Handler 交给 Hono
  await renamedCard.getByRole('button', { name: t('user.players.delete') }).click()
  const confirm = page.getByRole('alertdialog', { name: t('user.players.deleteTitle', { name: renamed }) })
  await expect(confirm).toHaveAccessibleDescription(t('user.players.deleteRefund', { refund: 100 }))
  await confirm.getByRole('button', { name: t('user.players.deleteConfirm') }).click()
  await expect(page.getByText(t('user.players.deletedRefund', { name: renamed, refund: 100 }))).toBeVisible()
  await expect(renamedCard).toHaveCount(0)
  // 注册时送的角色删掉不退积分
  const own = page.getByRole('article').filter({ has: page.getByRole('heading', { name }) })
  await own.getByRole('button', { name: t('user.players.delete') }).click()
  await expect(page.getByRole('alertdialog')).toHaveAccessibleDescription(t('user.players.deleteNoRefund'))
})
