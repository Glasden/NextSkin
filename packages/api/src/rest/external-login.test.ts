import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { toIsoTimestamp, writeAuthDate } from '../../../db/src/index.ts'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import github from '../../../../plugins/oauth-github/src/official.ts'
import { totp } from '../../../domain/src/auth/security.test-helper.ts'
import { buildPackage, hostEntry, pluginPackages } from '../../../domain/src/plugins/host.test-helper.ts'
import { pluginEnvironment } from '../../../domain/src/plugins/plugins.test-helper.ts'
import { createApp } from '../app.ts'
import { errorSchema } from './errors.ts'

const origin = 'https://skin.example.test'
const password = 'correct horse battery staple'
const authorizationCode = 'private-authorization-code'
const accessToken = 'private-access-token'
const privateMessage = 'private-plugin-message'

// 同一份 GitHub 源码经过两条加载路径；白名单和 RPC 都保留，只替换最终出站请求。
describe.each(['official', 'host'] as const)('GitHub 第三方登录（%s）', (loading) => {
  const env = pluginEnvironment()
  const id = loading === 'host' ? 'host-oauth-github' : 'oauth-github'
  const path = `/external-login/${id}/github`
  const callbackPath = `/api${path}/callback`
  let app: ReturnType<typeof createApp>
  let actor: Awaited<ReturnType<typeof env.actor>>
  let subject = 123
  let email = 'github-person@example.test'
  let verified = true
  let mode: 'ok' | 'throw' | 'token-error' | 'invalid-subject' | 'timeout' = 'ok'
  let tokenBody: URLSearchParams | undefined
  let arrived: (() => void) | undefined
  const outbound = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init)
    arrived?.()
    if (mode === 'timeout') return new Promise<Response>(() => {})
    if (mode === 'throw') throw new Error(`${privateMessage} ${authorizationCode} ${accessToken} ${email}`)
    if (request.url === 'https://github.com/login/oauth/access_token') {
      tokenBody = new URLSearchParams(await request.text())
      if (mode === 'token-error') return new Response(`${accessToken} ${email}`, { status: 400 })
      return Response.json({ access_token: accessToken, token_type: 'Bearer' })
    }
    if (request.url === 'https://api.github.com/user')
      return Response.json({
        id: mode === 'invalid-subject' ? 'invalid subject' : subject,
        login: 'octocat',
        name: 'GitHub Person',
      })
    if (request.url === 'https://api.github.com/user/emails') return Response.json([{ email, primary: true, verified }])
    throw new Error('测试不允许其它出站地址')
  })

  let packageBytes: Uint8Array
  beforeAll(async () => {
    if (loading === 'host') {
      // helper 的临时包没有 workspace 的 node_modules；显式解析共用库，仍打包同一份 GitHub 源码。
      const source = (
        await readFile(new URL('../../../../plugins/oauth-github/src/index.ts', import.meta.url), 'utf8')
      ).replace(
        "'@nextskin/oauth-client'",
        JSON.stringify(fileURLToPath(new URL('../../../oauth-client/src/index.ts', import.meta.url))),
      )
      packageBytes = await buildPackage({ id, source, locales: github.messages })
    }
  }, 60_000)
  beforeEach(async () => {
    subject = 123
    email = 'github-person@example.test'
    verified = true
    mode = 'ok'
    tokenBody = undefined
    arrived = undefined
    outbound.mockClear()
    await env.boot(loading === 'official' ? [github] : [], {
      plugins: {
        fetch: outbound,
        ...(loading === 'host' ? { host: hostEntry, packages: (await pluginPackages()).packages } : {}),
      },
    })
    actor = await env.actor()
    if (loading === 'host') {
      const bytes = packageBytes
      const preview = await env.core.plugins.admin.preview(actor, bytes)
      await env.core.plugins.admin.install(actor, bytes, preview.packageHash)
    }
    await env.core.plugins.admin.enable(actor, id)
    app = createApp({ core: env.core })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  class Browser {
    locale = 'en'
    readonly jar = new Map<string, string>()
    cookie() {
      return [...this.jar].map(([key, value]) => `${key}=${value}`).join('; ')
    }
    async send(method: string, route: string, body?: unknown) {
      const response = await app.request(
        origin + route,
        {
          method,
          headers: {
            host: 'skin.example.test',
            'x-forwarded-proto': 'https',
            origin,
            'accept-language': this.locale,
            cookie: this.cookie(),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        { peer: '192.0.2.10' },
      )
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0]!
        const index = pair.indexOf('=')
        const name = pair.slice(0, index),
          value = pair.slice(index + 1)
        if (!value || /max-age=0/i.test(cookie)) this.jar.delete(name)
        else this.jar.set(name, value)
      }
      return response
    }
    post(route: string, body: unknown) {
      return this.send('POST', '/api' + route, body)
    }
    callback(state: string, query: Record<string, string> = { code: authorizationCode }) {
      return this.send('GET', callbackPath + '?' + new URLSearchParams({ state, ...query }).toString())
    }
    session() {
      return env.core.auth.getSessionUser(new Headers({ cookie: this.cookie() }), origin)
    }
  }
  async function configure() {
    await env.core.plugins.admin.updateSettings(actor, id, {
      clientId: 'test-client-id',
      clientSecret: 'private-client-secret',
    })
  }
  async function start(browser: Browser, intent: 'signIn' | 'link' = 'signIn', next = '/user/players') {
    const response = await browser.post(path, { intent, next })
    expect(response.status).toBe(200)
    const result = (await response.json()) as { url: string }
    const url = new URL(result.url)
    const state = url.searchParams.get('state')!
    expect(state).toBeTruthy()
    return { response, url, state }
  }
  test('授权地址和身份交换沿用各自 HTTP 请求的语言', async () => {
    await configure()
    const authorize = vi.spyOn(env.core.plugins, 'loginAuthorize')
    const exchange = vi.spyOn(env.core.plugins, 'loginExchange')
    const browser = new Browser()
    const { state } = await start(browser)
    expect(authorize).toHaveBeenLastCalledWith(id, 'github', expect.objectContaining({ locale: 'en' }))
    browser.locale = 'zh-CN'
    await browser.callback(state)
    expect(exchange).toHaveBeenLastCalledWith(id, 'github', expect.objectContaining({ locale: 'zh-CN' }))
  })

  async function account(withPassword = true) {
    const input = env.input({ email })
    const { uid } = await env.core.users.register(input)
    if (!withPassword) await env.db.deleteFrom('accounts').where('user_id', '=', uid).execute()
    return { uid, email: input.email }
  }
  async function login(address = email) {
    const browser = new Browser()
    expect((await browser.post('/auth/sign-in/email', { email: address, password })).status).toBe(200)
    return browser
  }
  async function bound(withPassword = true) {
    const user = await account(true)
    const browser = await login()
    expectRedirect(await browser.callback((await start(browser, 'link')).state), '/user/security?linked=1')
    if (!withPassword)
      await env.db
        .deleteFrom('accounts')
        .where('user_id', '=', user.uid)
        .where('provider_id', '=', 'credential')
        .execute()
    return { ...user, browser }
  }
  function expectRedirect(response: Response, location: string) {
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(location)
  }
  async function failure(response: Response, status: number, code: string) {
    expect(response.status).toBe(status)
    expect(errorSchema.parse(await response.json()).error.code).toBe(code)
  }
  function sessions(response: Response) {
    return response.headers
      .getSetCookie()
      .filter((c) => /(?:__Secure-)?nextskin\.session_token=.+/.test(c) && !/max-age=0/i.test(c))
  }
  async function stale(uid: number) {
    await env.db
      .updateTable('sessions')
      .set({ created_at: writeAuthDate(env.db, toIsoTimestamp(new Date(Date.now() - 601_000))) })
      .where('user_id', '=', uid)
      .execute()
  }
  const bindings = (uid: number) => env.db.selectFrom('accounts').selectAll().where('user_id', '=', uid).execute()

  test('缺设置不显示按钮且发起返回 404；填好后可用', async () => {
    expect(await env.core.externalLogin.providers()).toEqual([])
    await failure(await new Browser().post(path, { intent: 'signIn' }), 404, 'external_login_not_found')
    await configure()
    expect(await env.core.externalLogin.providers()).toEqual([
      { pluginId: id, providerId: 'github', label: 'login.github', icon: 'github' },
    ])
  })

  test('授权地址、PKCE 和 state Cookie 正确；站外 next 回退到用户中心', async () => {
    await configure()
    await bound()
    const browser = new Browser()
    const { response, url, state } = await start(browser, 'signIn', '//evil.test')
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe(origin + callbackPath)
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith('nextskin-external-state='))!
    expect(cookie.split(';')[0]).toBe(`nextskin-external-state=${state}`)
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/api/external-login/'])
      expect(cookie).toContain(attribute)
    expectRedirect(await browser.callback(state), '/user')
  })

  test('已有绑定登录签发真实会话，清 state，令牌请求的 verifier 匹配 challenge', async () => {
    await configure()
    const { uid } = await bound()
    const browser = new Browser()
    const { state, url } = await start(browser)
    const response = await browser.callback(state)
    expectRedirect(response, '/user/players')
    expect(sessions(response)).toHaveLength(1)
    expect(await browser.session()).toMatchObject({ uid })
    expect(
      response.headers.getSetCookie().some((c) => c.startsWith('nextskin-external-state=') && /Max-Age=0/i.test(c)),
    ).toBe(true)
    expect(tokenBody?.get('code')).toBe(authorizationCode)
    const verifier = tokenBody?.get('code_verifier')
    expect(verifier).toBeTruthy()
    expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
  })

  test('首次登录暂存身份，完成注册无 credential、无第三方令牌，签发会话；缺 Cookie 拒绝', async () => {
    await configure()
    const browser = new Browser()
    const response = await browser.callback((await start(browser)).state)
    expectRedirect(response, '/sign-in/complete')
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith('nextskin-external-pending='))!
    expect(cookie).toContain('Path=/;')
    expect(cookie).toContain('HttpOnly')
    const body = { email, playerName: 'FirstGitHub' }
    await failure(await new Browser().post('/external-login/complete', body), 400, 'external_login_expired')
    const complete = await browser.post('/external-login/complete', body)
    expect(complete.status).toBe(201)
    const result = (await complete.json()) as { uid: number }
    expect(result).toMatchObject({ signedIn: true, next: '/user/players' })
    expect(sessions(complete)).toHaveLength(1)
    expect(await browser.session()).toMatchObject({ uid: result.uid })
    expect(await bindings(result.uid)).toEqual([
      expect.objectContaining({
        provider_id: `plugin:${id}:github`,
        account_id: String(subject),
        password: null,
        access_token: null,
        refresh_token: null,
        id_token: null,
        scope: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
      }),
    ])
  })

  test.each(['password', 'verified', 'unverified'] as const)('邮箱已存在时：%s', async (kind) => {
    await configure()
    const { uid } = await account(kind === 'password')
    verified = kind !== 'unverified'
    const browser = new Browser()
    const response = await browser.callback((await start(browser)).state)
    if (kind === 'verified') {
      expectRedirect(response, '/user/players')
      expect(await browser.session()).toMatchObject({ uid })
      expect(await bindings(uid)).toHaveLength(1)
    } else {
      expectRedirect(response, '/sign-in?error=external_email_taken')
      expect((await bindings(uid)).filter((r) => r.provider_id.startsWith('plugin:'))).toEqual([])
      expect(await browser.session()).toBeNull()
    }
  })

  test('两步验证先签挑战，TOTP 后才有会话；信任设备再次登录直接签会话', async () => {
    await configure()
    const { uid, browser: setup } = await bound()
    const enabled = await setup.post('/auth/two-factor/enable', { password })
    expect(enabled.status).toBe(200)
    const result = (await enabled.json()) as { totpURI: string }
    const secret = new URL(result.totpURI).searchParams.get('secret')!
    expect((await setup.post('/auth/two-factor/verify-totp', { code: totp(secret) })).status).toBe(200)
    const browser = new Browser()
    const response = await browser.callback((await start(browser)).state)
    expectRedirect(response, '/sign-in/two-factor?next=%2Fuser%2Fplayers')
    expect(sessions(response)).toEqual([])
    expect(response.headers.getSetCookie().some((c) => c.includes('two_factor='))).toBe(true)
    expect(await browser.session()).toBeNull()
    const second = await browser.post('/auth/two-factor/verify-totp', { code: totp(secret), trustDevice: true })
    expect(second.status).toBe(200)
    expect(sessions(second)).toHaveLength(1)
    expect(await browser.session()).toMatchObject({ uid })
    expect([...browser.jar.keys()].some((name) => name.includes('trust_device'))).toBe(true)
    expect((await browser.post('/auth/sign-out', {})).status).toBe(200)
    const trusted = await browser.callback((await start(browser)).state)
    expectRedirect(trusted, '/user/players')
    expect(sessions(trusted)).toHaveLength(1)
    expect(await browser.session()).toMatchObject({ uid })
  })

  test.each(['missing-cookie', 'expired', 'cancelled'] as const)('state 校验与取消：%s，不交换身份', async (kind) => {
    await configure()
    let browser = new Browser()
    const { state } = await start(browser)
    if (kind === 'missing-cookie') browser = new Browser()
    if (kind === 'expired')
      await env.db
        .updateTable('verifications')
        .set({ expires_at: writeAuthDate(env.db, toIsoTimestamp(new Date(0))) })
        .where('identifier', 'like', 'external-login:state:%')
        .execute()
    const response = await browser.callback(
      state,
      kind === 'cancelled' ? { error: 'access_denied' } : { code: authorizationCode },
    )
    expectRedirect(response, `/sign-in?error=external_login_${kind === 'cancelled' ? 'cancelled' : 'expired'}`)
    expect(outbound).not.toHaveBeenCalled()
  })

  test.each(['throw', 'token-error', 'invalid-subject', 'timeout'] as const)(
    '第三方失败 %s 返回固定错误且日志不含秘密',
    async (kind) => {
      await configure()
      const browser = new Browser()
      const { state } = await start(browser)
      mode = kind
      let response: Response
      if (kind === 'timeout') {
        // 只推进核心的期限计时器；host 的 IPC 和数据库仍使用真实事件循环。
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const received = new Promise<void>((resolve) => {
          arrived = resolve
        })
        const responsePromise = browser.callback(state)
        await received
        await vi.advanceTimersByTimeAsync(15_001)
        response = await responsePromise
        vi.useRealTimers()
      } else response = await browser.callback(state)
      expectRedirect(response, '/sign-in?error=external_login_failed')
      expect(await browser.session()).toBeNull()
      const logs = env.lines.join('\n')
      expect(logs).toContain('login_failed')
      for (const secret of [
        authorizationCode,
        accessToken,
        email,
        privateMessage,
        'private-client-secret',
        'token request failed',
        'invalid user response',
        'invalid token response',
      ])
        expect(logs).not.toContain(secret)
    },
    30_000,
  )

  test('绑定要求新鲜会话；成功跳安全页；回调换用户拒绝，别人已绑定的身份也拒绝', async () => {
    await configure()
    const a = await account()
    const browser = await login()
    await stale(a.uid)
    await failure(await browser.post(path, { intent: 'link' }), 403, 'session_not_fresh')
    const fresh = await login()
    const { state } = await start(fresh, 'link')
    const otherEmail = 'other-user@example.test'
    await env.core.users.register(env.input({ email: otherEmail }))
    const other = await login(otherEmail)
    other.jar.set('nextskin-external-state', state)
    expectRedirect(await other.callback(state), '/user/security?error=external_login_expired')
    expectRedirect(await fresh.callback((await start(fresh, 'link')).state), '/user/security?linked=1')
    expectRedirect(
      await other.callback((await start(other, 'link')).state),
      '/user/security?error=identity_bound_elsewhere',
    )
    expect((await bindings(a.uid)).filter((row) => row.provider_id.startsWith('plugin:'))).toHaveLength(1)
  })

  test('绑定认发起它的那个会话：同一个人换一个会话完成回调按过期处理，原会话照常能绑', async () => {
    await configure()
    const { uid } = await account()
    const browser = await login()
    const { state } = await start(browser, 'link')
    const second = await login()
    second.jar.set('nextskin-external-state', state)
    expectRedirect(await second.callback(state), '/user/security?error=external_login_expired')
    expect((await bindings(uid)).filter((row) => row.provider_id.startsWith('plugin:'))).toEqual([])
    expectRedirect(await browser.callback((await start(browser, 'link')).state), '/user/security?linked=1')
    expect((await bindings(uid)).filter((row) => row.provider_id.startsWith('plugin:'))).toHaveLength(1)
  })

  test('解绑最后一种方式返回 409；有密码时解绑成功并删除绑定', async () => {
    await configure()
    const { uid, browser } = await bound(false)
    await failure(await browser.send('DELETE', `/api/user/bindings/${id}/github`), 409, 'last_login_method')
    expect(await bindings(uid)).toHaveLength(1)
    expect((await browser.post('/user/password', { password })).status).toBe(200)
    expect((await browser.send('DELETE', `/api/user/bindings/${id}/github`)).status).toBe(200)
    expect((await bindings(uid)).map((r) => r.provider_id)).toEqual(['credential'])
  })

  test('无密码账号设置密码：拒绝短密码和旧会话，成功后能登录，不能重复设置', async () => {
    await configure()
    const { uid, browser } = await bound(false)
    await failure(await browser.post('/user/password', { password: 'short' }), 400, 'password_too_short')
    await stale(uid)
    await failure(await browser.post('/user/password', { password }), 403, 'session_not_fresh')
    const fresh = new Browser()
    expectRedirect(await fresh.callback((await start(fresh)).state), '/user/players')
    expect((await fresh.post('/user/password', { password })).status).toBe(200)
    expect(await (await login()).session()).toMatchObject({ uid })
    await failure(await fresh.post('/user/password', { password }), 409, 'password_already_set')
  })

  test.each([
    ['POST', '/api/auth/sign-in/social'],
    ['GET', '/api/auth/callback/github'],
    ['POST', '/api/auth/unlink-account'],
    ['GET', '/api/auth/list-accounts'],
  ])('Better Auth 自带端点已关闭：%s %s', async (method, route) => {
    expect(
      (
        await new Browser().send(
          method,
          route,
          method === 'POST' ? { provider: 'github', providerId: 'github' } : undefined,
        )
      ).status,
    ).toBe(404)
  })
})
