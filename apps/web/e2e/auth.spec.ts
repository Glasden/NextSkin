import { createTranslator } from '@nextskin/i18n'
import { expect, test } from '@playwright/test'

// Better Auth 经 Next 的 catch-all 路由和 standalone 产物（Turbopack 打包）能正常工作。
// 认证行为本身由 packages/domain 的 auth.db.test.ts 守护。
// 播种数据里的站点地址是录制 BS 时的地址（tests/contract/src/world.ts），issuer 和受信任的 Origin 都取自它。
const SITE = 'http://127.0.0.1:38080'

test('发现文档的 issuer 取自站点设置', async ({ request }) => {
  const res = await request.get('/api/auth/.well-known/openid-configuration')
  expect(res.status()).toBe(200)
  const metadata = (await res.json()) as Record<string, unknown>
  expect(metadata.issuer).toBe(`${SITE}/api/auth`)
  expect(metadata.id_token_signing_alg_values_supported).toEqual(['RS256'])
})

// 注册走领域用例（ADR-0018），Better Auth 自带的注册入口关闭。注册由 /api/register 处理
test('Better Auth 的邮箱注册入口已关闭', async ({ request }) => {
  const res = await request.post('/api/auth/sign-up/email', {
    headers: { origin: SITE },
    data: { email: `e2e-${Date.now()}@example.test`, password: 'correct horse battery staple', name: 'E2E' },
  })
  expect(res.status()).toBe(400)
  expect(((await res.json()) as { code: string }).code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED')
})

test('来自其他 Origin 的登录请求被拒绝', async ({ request }) => {
  const res = await request.post('/api/auth/sign-in/email', {
    headers: { origin: 'https://evil.example.test' },
    data: { email: 'nobody@example.test', password: 'whatever-password' },
  })
  expect(res.status()).toBe(403)
})

test('注册成功后响应 Cookie 能读取同一用户的会话', async ({ request }) => {
  const email = `session-${Date.now()}@example.test`
  const response = await request.post('/api/register', {
    headers: { 'x-forwarded-for': '203.0.113.10' },
    data: { email, password: 'correct horse battery staple', playerName: 'E2ESession' },
  })
  expect(response.status()).toBe(201)
  const registered = (await response.json()) as { uid: number; signedIn: boolean }
  expect(registered.signedIn).toBe(true)
  const cookie = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value.split(';')[0])
    .join('; ')
  expect(cookie).toContain('nextskin.session_token=')
  const sessionResponse = await request.get('/api/auth/get-session', { headers: { cookie } })
  expect(sessionResponse.status()).toBe(200)
  expect(await sessionResponse.json()).toMatchObject({ user: { id: String(registered.uid), email } })
})

test('同一客户端 IP 默认最多注册三次，换一个 IP 可以继续注册', async ({ request }) => {
  const stamp = Date.now()
  for (let index = 0; index < 4; index++) {
    const response = await request.post('/api/register', {
      headers: { 'x-forwarded-for': '198.51.100.10' },
      data: {
        email: `limit-${stamp}-${index}@example.test`,
        password: 'correct horse battery staple',
        playerName: `E2ELimit${index}`,
      },
    })
    expect(response.status()).toBe(index < 3 ? 201 : 403)
    if (index === 3) expect(await response.json()).toMatchObject({ error: { code: 'ip_limit_reached' } })
  }
  const response = await request.post('/api/register', {
    headers: { 'x-forwarded-for': '198.51.100.11' },
    data: {
      email: `limit-${stamp}-other@example.test`,
      password: 'correct horse battery staple',
      playerName: 'E2ELimitOther',
    },
  })
  expect(response.status()).toBe(201)
})

test('重复邮箱返回英文文案与字段错误', async ({ request }) => {
  const email = `duplicate-${Date.now()}@example.test`
  expect(
    (
      await request.post('/api/register', {
        headers: { 'x-forwarded-for': '203.0.113.20' },
        data: { email, password: 'correct horse battery staple', playerName: 'E2EDuplicate' },
      })
    ).status(),
  ).toBe(201)
  const response = await request.post('/api/register', {
    headers: { 'x-forwarded-for': '203.0.113.20', 'accept-language': 'en' },
    data: { email, password: 'correct horse battery staple', playerName: 'E2EAnother' },
  })
  expect(response.status()).toBe(409)
  const message = createTranslator('en')('errors.email_taken')
  expect(await response.json()).toEqual({
    error: { code: 'email_taken', message, fields: { email: { code: 'email_taken', message } } },
  })
})
