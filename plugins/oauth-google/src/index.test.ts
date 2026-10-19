import { buildManifest } from '@nextskin/plugin-host'
import type { Fetch } from '@nextskin/oauth-client'
import { expect, test, vi } from 'vitest'
import plugin from './official.ts'

const provider = plugin.definition.providers!.login![0]!
const settings = { clientId: 'client + id', clientSecret: 'private-secret' }
const redirectUri = 'https://skin.test/api/auth/plugin-login/oauth-google/google/callback'
const code = 'private-code'
const accessToken = 'private-token'
const tokenUrl = 'https://oauth2.googleapis.com/token'
const issuer = 'https://accounts.google.com'
const claims = {
  iss: issuer,
  aud: settings.clientId,
  exp: Math.floor(Date.now() / 1000) + 3600,
  sub: 'google-subject',
  email: 'person@example.test',
  name: 'Alex',
  email_verified: true,
}
const idToken = (value: unknown) => `header.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`

function context(fetch: Fetch): Parameters<typeof provider.exchange>[0]['ctx'] {
  return {
    settings,
    plugin: { id: 'oauth-google', version: '1.0.0' },
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
    [`POST ${tokenUrl}`]: Response.json({ access_token: accessToken, id_token: idToken(claims) }),
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
  expect(manifest.id).toBe('oauth-google')
  expect(manifest.network).toEqual(['https://oauth2.googleapis.com'])
  expect(manifest.capabilities).toEqual([])
  expect(manifest.providers).toEqual({
    passwordHasher: [],
    login: [{ id: 'google', label: 'login.google', icon: 'google' }],
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
    expect(messages.login.google).toBeTruthy()
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
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: 'code',
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    state: 'state + &',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    scope: 'openid email profile',
  })
  expect(fetch).not.toHaveBeenCalled()
})

test('交换身份的请求使用指定地址、方法、请求头和表单参数', async () => {
  const { result, fetch } = run()
  expect(await result).toEqual({
    subject: 'google-subject',
    email: 'person@example.test',
    emailVerified: true,
    displayName: 'Alex',
  })
  const requests = fetch.mock.calls.map(([request]) => request)
  expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([`POST ${tokenUrl}`])
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
  expect(request.headers.has('authorization')).toBe(false)
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
  Response.json({ id_token: 'private-token' }),
  Response.json({ id_token: 123 }),
])('令牌交换失败或响应不完整时抛错，错误里没有机密：%#', async (response) => {
  await expectFailure(run({ [`POST ${tokenUrl}`]: response }).result)
})

test('底层网络错误中的授权码和令牌不会传出去', async () => {
  const fetch: Fetch = () => Promise.reject(new Error('private-code private-token private-secret person@example.test'))
  await expectFailure(
    provider.exchange({ query: { code }, codeVerifier: 'verifier', redirectUri, ctx: context(fetch) }),
  )
})

test.each([true, false, undefined])('只信 email_verified 为 true：%j', async (email_verified) => {
  expect(
    await run({ [`POST ${tokenUrl}`]: Response.json({ id_token: idToken({ ...claims, email_verified }) }) }).result,
  ).toMatchObject({ emailVerified: email_verified === true })
})

test('没有邮箱和名字时返回 null', async () => {
  expect(
    await run({
      [`POST ${tokenUrl}`]: Response.json({
        id_token: idToken({
          ...claims,
          email: undefined,
          name: undefined,
          email_verified: undefined,
        }),
      }),
    }).result,
  ).toEqual({ subject: 'google-subject', email: null, emailVerified: false, displayName: null })
})

test.each([
  { ...claims, sub: undefined },
  { ...claims, sub: '' },
  { ...claims, sub: 123 },
  { ...claims, aud: 'wrong-client' },
  { ...claims, iss: 'https://wrong.test' },
  { ...claims, exp: 0 },
  { ...claims, email_verified: 'true' },
  { ...claims, email: 123 },
])('不接受缺 sub、非法身份或不属于本应用的 ID 令牌：%j', async (body) => {
  await expectFailure(run({ [`POST ${tokenUrl}`]: Response.json({ id_token: idToken(body) }) }).result)
})

test.each(['https://accounts.google.com', 'accounts.google.com'])(
  '接受 Google 的 issuer %s 和数组 aud',
  async (iss) => {
    expect(
      await run({
        [`POST ${tokenUrl}`]: Response.json({
          id_token: idToken({ ...claims, iss, aud: ['other', settings.clientId] }),
        }),
      }).result,
    ).toMatchObject({ subject: 'google-subject' })
  },
)
