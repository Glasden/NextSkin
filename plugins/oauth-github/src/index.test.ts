import { buildManifest } from '@nextskin/plugin-host'
import type { Fetch } from '@nextskin/oauth-client'
import { expect, test, vi } from 'vitest'
import plugin from './official.ts'

const provider = plugin.definition.providers!.login![0]!
const settings = { clientId: 'client + id', clientSecret: 'private-secret' }
const redirectUri = 'https://skin.test/api/auth/plugin-login/oauth-github/github/callback'
const code = 'private-code'
const accessToken = 'private-token'
const tokenUrl = 'https://github.com/login/oauth/access_token'
const user = { id: 123, login: 'octocat', name: 'Alex' }
const userUrl = 'https://api.github.com/user'

function context(fetch: Fetch): Parameters<typeof provider.exchange>[0]['ctx'] {
  return {
    settings,
    plugin: { id: 'oauth-github', version: '1.0.0' },
    site: { url: 'https://skin.test', name: 'Skin' },
    t: (key) => key,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    jobs: { enqueue: () => Promise.resolve() },
    fetch: (input, init) => fetch(new Request(input, init)),
  }
}

function run(overrides: Record<string, Response> = {}, query: Readonly<Record<string, string>> = { code }) {
  const responses: Record<string, Response> = {
    [`POST ${tokenUrl}`]: Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600 }),
    [`GET ${userUrl}`]: Response.json(user),
    'GET https://api.github.com/user/emails': Response.json([
      { email: 'secondary@example.test', primary: false, verified: true },
      { email: 'person@example.test', primary: true, verified: true },
    ]),
    ...overrides,
  }
  const fetch = vi.fn((request: Request) => {
    const response = responses[`${request.method} ${request.url}`]
    if (!response) throw new Error('unexpected request')
    return Promise.resolve(response.clone())
  })
  const result = provider.exchange({ query, codeVerifier: 'verifier + value', redirectUri, ctx: context(fetch) })
  return { result, fetch }
}

async function expectFailure(result: Promise<unknown>) {
  await expect(result).rejects.toThrow()
  await expect(result).rejects.not.toThrow(/private-code|private-token|private-secret|person@example\.test/)
}

test('manifest 只有一个 login Provider，两项设置必填，密钥不回传', () => {
  const manifest = buildManifest(plugin.definition, plugin.package)
  expect(manifest.id).toBe('oauth-github')
  expect(manifest.network).toEqual(['https://github.com', 'https://api.github.com'])
  expect(manifest.capabilities).toEqual([])
  expect(manifest.providers).toEqual({
    passwordHasher: [],
    login: [{ id: 'github', label: 'login.github', icon: 'github' }],
  })
  const schema = manifest.settingsSchema as {
    properties: Record<string, { writeOnly?: boolean; default?: unknown }>
    required: string[]
  }
  expect(Object.keys(schema.properties).sort()).toEqual(['clientId', 'clientSecret'])
  expect(schema.required.sort()).toEqual(['clientId', 'clientSecret'])
  expect(schema.properties.clientSecret?.writeOnly).toBe(true)
  expect(schema.properties.clientId?.default).toBeUndefined()
  expect(plugin.definition.settings!.safeParse({}).success).toBe(false)
  expect(plugin.definition.settings!.safeParse({ clientId: ' ', clientSecret: 'secret' }).success).toBe(false)
  expect(plugin.definition.settings!.safeParse({ clientId: 'x'.repeat(201), clientSecret: 'secret' }).success).toBe(
    false,
  )
  expect(plugin.definition.settings!.safeParse({ clientId: 'id', clientSecret: '' }).success).toBe(false)
  expect(plugin.definition.settings!.parse({ ...settings, clientId: ' id ' }).clientId).toBe('id')
  for (const messages of Object.values(plugin.messages)) {
    expect(messages.plugin.name).toBeTruthy()
    expect(messages.plugin.description).toBeTruthy()
    expect(messages.login.github).toBeTruthy()
    for (const field of Object.values(messages.settings)) {
      expect(field.label).toBeTruthy()
      expect(field.help).toBeTruthy()
    }
  }
})

test('授权地址包含回调、state 和 S256 PKCE，只申请所需 scope', async () => {
  const fetch = vi.fn<Fetch>()
  const url = new URL(
    await provider.authorizeUrl({ state: 'state + &', codeChallenge: 'challenge', redirectUri, ctx: context(fetch) }),
  )
  expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: 'code',
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    state: 'state + &',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    scope: 'read:user user:email',
  })
  expect(fetch).not.toHaveBeenCalled()
})

test('交换身份的请求使用指定地址、方法、请求头和表单参数', async () => {
  const { result, fetch } = run()
  expect(await result).toEqual({
    subject: '123',
    email: 'person@example.test',
    emailVerified: true,
    displayName: 'Alex',
  })
  const requests = fetch.mock.calls.map(([request]) => request)
  expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
    `POST ${tokenUrl}`,
    `GET ${userUrl}`,
    'GET https://api.github.com/user/emails',
  ])
  const request = requests[0]!
  expect(request.headers.get('accept')).toBe('application/json')
  expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
  expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    code_verifier: 'verifier + value',
  })
  for (const request of requests.slice(1)) {
    expect(request.headers.get('authorization')).toBe(`Bearer ${accessToken}`)
    expect(request.headers.get('user-agent')).toBe('NextSkin')
    expect(request.headers.get('accept')).toBe('application/vnd.github+json')
    expect(request.headers.get('x-github-api-version')).toBe('2022-11-28')
  }
})

test.each([{}, { code: '' }] as Readonly<Record<string, string>>[])(
  '缺授权码不请求第三方：%j',
  async (query: Readonly<Record<string, string>>) => {
    const { result, fetch } = run({}, query)
    await expectFailure(result)
    expect(fetch).not.toHaveBeenCalled()
  },
)

test.each([
  new Response('private-code private-token person@example.test', { status: 400 }),
  new Response('private-code private-token person@example.test'),
  Response.json({ error: 'private-token', error_description: 'private-code' }),
  Response.json({}),
  Response.json([]),
  Response.json(null),
  Response.json({ access_token: '' }),
  Response.json({ access_token: 123 }),
  Response.json({ access_token: 'private-token\r\nX-Injected: secret' }),
])('令牌交换失败或响应不完整时抛错，错误里没有机密：%#', async (response) => {
  await expectFailure(run({ [`POST ${tokenUrl}`]: response }).result)
})

test('底层网络错误中的授权码和令牌不会传出去', async () => {
  const fetch: Fetch = () => Promise.reject(new Error('private-code private-token private-secret person@example.test'))
  await expectFailure(
    provider.exchange({ query: { code }, codeVerifier: 'verifier', redirectUri, ctx: context(fetch) }),
  )
})

test.each([true, false])('只信 primary 邮箱自己的 verified：%s', async (verified) => {
  const { result } = run({
    'GET https://api.github.com/user/emails': Response.json([
      { email: 'secondary@example.test', primary: false, verified: true },
      { email: 'person@example.test', primary: true, verified },
    ]),
  })
  expect(await result).toMatchObject({ email: 'person@example.test', emailVerified: verified })
})

test.each([[], [{ email: 'secondary@example.test', primary: false, verified: true }]].map((emails) => ({ emails })))(
  '没有 primary 邮箱时返回 null：%j',
  async ({ emails }) => {
    expect(await run({ 'GET https://api.github.com/user/emails': Response.json(emails) }).result).toMatchObject({
      email: null,
      emailVerified: false,
    })
  },
)

test.each([null, '', '  '])('没有名字就用 login，subject 不随 login 变化：%j', async (name) => {
  expect(await run({ [`GET ${userUrl}`]: Response.json({ ...user, login: 'renamed', name }) }).result).toMatchObject({
    subject: '123',
    displayName: 'renamed',
  })
})

test.each(
  [
    {},
    { ...user, id: '123' },
    { ...user, id: 1.5 },
    { ...user, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...user, login: null },
    [],
    null,
  ].map((body) => ({ body })),
)('用户资料缺字段或类型不对时失败：%j', async ({ body }) => {
  await expectFailure(run({ [`GET ${userUrl}`]: Response.json(body) }).result)
})

test.each([userUrl, 'https://api.github.com/user/emails'])('资料端点 %s 的错误也不能泄露机密', async (url) => {
  for (const response of [
    new Response('private-code private-token', { status: 403 }),
    new Response('private-code private-token'),
    Response.json({ error: 'private-token' }),
  ])
    await expectFailure(run({ [`GET ${url}`]: response }).result)
})

test.each([[{}], [{ email: 'person@example.test', primary: true }], [null]].map((body) => ({ body })))(
  '邮箱列表缺字段时失败：%j',
  async ({ body }) => {
    await expectFailure(run({ 'GET https://api.github.com/user/emails': Response.json(body) }).result)
  },
)
