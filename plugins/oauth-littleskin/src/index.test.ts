import { buildManifest } from '@nextskin/plugin-host'
import { expect, test, vi } from 'vitest'
import plugin from './official.ts'

type Fetch = (request: Request) => Promise<Response>

const provider = plugin.definition.providers!.login![0]!
const settings = { clientId: 'client + id', clientSecret: 'private-secret' }
const redirectUri = 'https://skin.test/api/auth/plugin-login/oauth-littleskin/littleskin/callback'
const code = 'private-code'
const accessToken = 'private-token'
const tokenUrl = 'https://littleskin.cn/oauth/token'
const user = { uid: 123, email: 'person@example.test', verified: 1, nickname: 'Alex' }
const userUrl = 'https://littleskin.cn/api/user'

function context(fetch: Fetch): Parameters<typeof provider.exchange>[0]['ctx'] {
  return {
    settings,
    plugin: { id: 'oauth-littleskin', version: '1.0.0' },
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
  expect(manifest.id).toBe('oauth-littleskin')
  expect(manifest.network).toEqual(['https://littleskin.cn'])
  expect(manifest.capabilities).toEqual([])
  expect(manifest.providers).toEqual({
    passwordHasher: [],
    login: [{ id: 'littleskin', label: 'login.littleskin', icon: 'login' }],
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
    expect(messages.login.littleskin).toBeTruthy()
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
  expect(url.origin + url.pathname).toBe('https://littleskin.cn/oauth/authorize')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: 'code',
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    state: 'state + &',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
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
  expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([`POST ${tokenUrl}`, `GET ${userUrl}`])
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
    expect(request.headers.get('accept')).toBe('application/json')
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

test.each([true, 1, false, 0])('verified 只有 true 和 1 才表示邮箱已验证：%j', async (verified) => {
  expect(await run({ [`GET ${userUrl}`]: Response.json({ ...user, verified }) }).result).toMatchObject({
    emailVerified: verified === true || verified === 1,
  })
})

test('没有邮箱和昵称时返回 null', async () => {
  expect(await run({ [`GET ${userUrl}`]: Response.json({ uid: 123, verified: false }) }).result).toEqual({
    subject: '123',
    email: null,
    emailVerified: false,
    displayName: null,
  })
})

test.each(
  [
    {},
    { ...user, uid: undefined },
    { ...user, uid: '123' },
    { ...user, uid: 1.5 },
    { ...user, uid: Number.MAX_SAFE_INTEGER + 1 },
    { ...user, verified: '1' },
    { ...user, verified: undefined },
    [],
    null,
    { code: 403, message: 'private-token' },
  ].map((body) => ({ body })),
)('用户资料缺字段或类型不对时失败：%j', async ({ body }) => {
  await expectFailure(run({ [`GET ${userUrl}`]: Response.json(body) }).result)
})

test.each([new Response('private-code private-token', { status: 401 }), new Response('private-code private-token')])(
  '用户资料请求失败时不泄露机密：%#',
  async (response) => {
    await expectFailure(run({ [`GET ${userUrl}`]: response }).result)
  },
)
