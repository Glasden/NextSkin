import { createTranslator } from '@nextskin/i18n'
import { expect, test } from './fixtures'

test.use({ locale: 'zh-CN', extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.70' } })

const t = createTranslator('zh-CN')

test('启动器登录、进服、从安全页退出后令牌失效', async ({ page }) => {
  const suffix = String(Date.now()).slice(-6)
  const email = `launcher-${suffix}@example.test`
  const password = 'correct horse battery staple'
  const name = `La${suffix}`
  const registered = await page.request.post('/api/register', { data: { email, password, playerName: name } })
  expect(registered.status()).toBe(201)

  await page.goto('/user')
  const launcher = page.locator('#launcher')
  await expect(launcher.locator('code')).toHaveText(/\/api\/yggdrasil$/)
  await expect(launcher.getByRole('button', { name: t('user.dashboard.launcher.copy') })).toBeVisible()

  const authenticated = await page.request.post('/api/yggdrasil/authserver/authenticate', {
    data: { username: email, password },
  })
  expect(authenticated.status()).toBe(200)
  const auth = (await authenticated.json()) as { accessToken: string; selectedProfile: { id: string; name: string } }
  expect(auth.accessToken).toBeTruthy()
  expect(auth.selectedProfile.name).toBe(name)
  const serverId = `launcher-server-${suffix}`
  const joined = await page.request.post('/api/yggdrasil/sessionserver/session/minecraft/join', {
    data: { accessToken: auth.accessToken, selectedProfile: auth.selectedProfile.id, serverId },
  })
  expect(joined.status()).toBe(204)
  const profile = await page.request.get('/api/yggdrasil/sessionserver/session/minecraft/hasJoined', {
    params: { username: name, serverId },
  })
  expect(profile.status()).toBe(200)
  expect(await profile.json()).toMatchObject({
    id: auth.selectedProfile.id,
    name,
    properties: expect.arrayContaining([expect.objectContaining({ name: 'textures', signature: expect.any(String) })]),
  })

  await page.goto('/user/security')
  const rows = page.locator('#launchers li')
  await expect(rows).toHaveCount(1)
  await rows.getByRole('button', { name: t('user.security.launchers.revoke'), exact: true }).click()
  await expect(rows).toHaveCount(0)
  const validated = await page.request.post('/api/yggdrasil/authserver/validate', {
    data: { accessToken: auth.accessToken },
  })
  expect(validated.status()).toBe(403)
})
