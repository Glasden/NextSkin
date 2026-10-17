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

// 注册走领域用例（ADR-0018），Better Auth 自带的注册入口关闭。注册接口落地后，在这里补上注册后取会话的用例
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
