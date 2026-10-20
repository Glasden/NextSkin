import { beforeEach, expect, test, vi } from 'vitest'
import { setup } from '../closet/test-support.ts'
import { captchaGuard } from '../auth/captcha.ts'
import { createCaptcha } from './service.ts'

const fetcher = vi.fn<typeof fetch>()
const env = setup({ captcha: { fetch: fetcher } })
const root = 'http://localhost:3000'
const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const password = 'a valid long password'

beforeEach(async () => {
  fetcher.mockReset().mockResolvedValue(Response.json({ success: true, hostname: 'localhost' }))
  await env.setting('captcha.provider', 'turnstile')
  await env.setting('captcha.siteKey', 'site')
  await env.setting('captcha.secretKey', 'secret')
  await env.setting('mail.transport', 'smtp')
  await env.setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
  await env.core.admin.setPasswordAsSystem(String(env.actor.uid), { password })
  await env.db().deleteFrom('jobs').execute()
  await env.db().deleteFrom('audit_logs').execute()
})

function request(path: string, token?: string) {
  return env.core.auth.handle(
    new Request(`${root}/api/auth${path}`, {
      method: 'POST',
      headers: {
        origin: root,
        'content-type': 'application/json',
        ...(token === undefined ? {} : { 'x-captcha-response': token }),
        'x-nextskin-client-ip': '203.0.113.99',
      },
      body: JSON.stringify({ email: 'actor@example.test', password, redirectTo: `${root}/reset-password` }),
    }),
    root,
    '198.51.100.8',
  )
}

test.each(['/sign-in/email', '/request-password-reset'])(
  'HTTP %s 缺令牌 400、不通过 403、不可用 503，通过后照常',
  async (path) => {
    const missing = await request(path)
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ code: 'captcha_required', message: 'Please complete the captcha.' })
    expect(fetcher).not.toHaveBeenCalled()
    for (const [success, status, code] of [
      [false, 403, 'captcha_failed'],
      [null, 503, 'captcha_unavailable'],
    ] as const) {
      fetcher.mockResolvedValueOnce(
        success === null ? new Response('down', { status: 503 }) : Response.json({ success }),
      )
      const response = await request(path, 'token')
      expect(response.status).toBe(status)
      const body = (await response.json()) as { code: string; message: string }
      expect(body.code).toBe(code)
      expect(body.message).toMatch(/[A-Za-z]/)
    }
    const passed = await request(path, 'fresh-token')
    expect(passed.status).toBe(200)
    expect((fetcher.mock.calls.at(-1)![1]!.body as URLSearchParams).get('remoteip')).toBe('198.51.100.8')
    if (path === '/sign-in/email') expect(passed.headers.getSetCookie().join()).toContain('nextskin.session_token')
    else
      expect(await env.db().selectFrom('jobs').select('id').where('name', '=', 'core:mail').execute()).toHaveLength(1)
  },
)

test('createSession 经 auth.api 不受验证码影响；改设置立即生效', async () => {
  const cookies = await env.core.auth.createSession({
    email: 'actor@example.test',
    password,
    clientIp: '198.51.100.8',
    userAgent: null,
    requestRoot: root,
  })
  expect(cookies.join()).toContain('nextskin.session_token')
  expect(fetcher).not.toHaveBeenCalled()
  expect((await request('/sign-in/email')).status).toBe(400)
  await env.setting('captcha.provider', 'none')
  expect((await request('/sign-in/email')).status).toBe(200)
  await env.setting('captcha.provider', 'turnstile')
  expect((await request('/sign-in/email')).status).toBe(400)
  expect(fetcher).not.toHaveBeenCalled()
})

test('Better Auth 先限流，超限时不会发出验证码核对请求', async () => {
  // 测试环境默认不启用限流，用实际 Better Auth 实例的 options 打开。
  const { createAuth } = await import('../auth/auth.ts')
  const captcha = createCaptcha(env.core.settings, fetcher)
  const instance = createAuth({
    db: env.db(),
    secretKey,
    siteUrl: root,
    siteName: 'Test',
    legacyPasswordSalt: () => Promise.resolve(''),
    captcha,
  })
  Object.assign(instance.options.rateLimit, {
    enabled: true,
    window: 60,
    max: 1,
    customRules: { '/sign-in/email': { window: 60, max: 1 } },
  })
  const call = () =>
    instance.handler(
      new Request(`${root}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin: root, 'content-type': 'application/json', 'x-nextskin-client-ip': '198.51.100.9' },
        body: JSON.stringify({ email: 'actor@example.test', password }),
      }),
    )
  expect((await call()).status).toBe(400)
  const response = await call()
  expect(response.status).toBe(429)
  expect(fetcher).not.toHaveBeenCalled()
})

test('插件和 Better Auth 的路由用同一个 basePath、同一种规范化，只拦两个 POST 入口', async () => {
  const verify = vi.fn().mockResolvedValue(undefined)
  const plugin = captchaGuard({ verify })
  const onRequest = (request: Request, baseURL = `${root}/api/auth`) =>
    plugin.onRequest(request, { baseURL } as Parameters<typeof plugin.onRequest>[1])
  const post = (path: string) =>
    new Request(root + path, {
      method: 'POST',
      headers: { 'x-captcha-response': 'token', 'x-nextskin-client-ip': '198.51.100.1' },
    })
  for (const path of ['/api/auth/sign-in/email', '/api/auth/request-password-reset/']) await onRequest(post(path))
  expect(verify).toHaveBeenCalledTimes(2)
  expect(verify).toHaveBeenLastCalledWith({ token: 'token', ip: '198.51.100.1' })
  // site.url 带路径时 Better Auth 的 basePath 就是那个路径，端点在它下面（审核发现）
  await onRequest(post('/api/auth/v2/sign-in/email'), `${root}/api/auth/v2`)
  await onRequest(post('/api/auth/v2/request-password-reset'), `${root}/api/auth/v2`)
  expect(verify).toHaveBeenCalledTimes(4)
  for (const [method, path] of [
    ['GET', '/api/auth/sign-in/email'],
    ['POST', '/api/auth/reset-password'],
    ['POST', '/api/auth/passkey/verify-authentication'],
    ['POST', '/api/auth/oauth2/token'],
    ['POST', '/api/auth/sign-up/email'],
    ['POST', '/api/auth/two-factor/verify-totp'],
  ])
    await onRequest(new Request(root + path, { method }))
  expect(verify).toHaveBeenCalledTimes(4)
})

test('site.url 带路径时，那个路径下的登录和找回密码照样要验证码', async () => {
  await env.setting('site.url', `${root}/api/auth/v2`)
  const response = await env.core.auth.handle(
    new Request(`${root}/api/auth/v2/sign-in/email`, {
      method: 'POST',
      headers: { origin: root, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'actor@example.test', password }),
    }),
    root,
    '198.51.100.8',
  )
  expect(response.status).toBe(400)
  expect(((await response.json()) as { code: string }).code).toBe('captcha_required')
  expect(fetcher).not.toHaveBeenCalled()
})
