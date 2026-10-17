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

test('注册后带着会话 Cookie 能取到当前会话', async ({ request }) => {
  const email = `e2e-${Date.now()}@example.test`
  const signUp = await request.post('/api/auth/sign-up/email', {
    headers: { origin: SITE },
    data: { email, password: 'correct horse battery staple', name: 'E2E' },
  })
  expect(signUp.status()).toBe(200)
  expect(signUp.headers()['set-cookie']).toMatch(/nextskin\.session_token=[^;]+;.*HttpOnly/)

  const session = await request.get('/api/auth/get-session')
  expect(session.status()).toBe(200)
  expect(((await session.json()) as { user: { email: string } }).user.email).toBe(email)
})

test('来自其他 Origin 的登录请求被拒绝', async ({ request }) => {
  const res = await request.post('/api/auth/sign-in/email', {
    headers: { origin: 'https://evil.example.test' },
    data: { email: 'nobody@example.test', password: 'whatever-password' },
  })
  expect(res.status()).toBe(403)
})
