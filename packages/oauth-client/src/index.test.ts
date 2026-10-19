import { expect, test, vi } from 'vitest'
import { authorizationUrl, exchangeCode, fetchJson, readIdToken } from './index.ts'

const args = {
  clientId: 'client & id',
  clientSecret: 'secret + value',
  redirectUri: 'https://skin.test/callback?x=1',
  query: { code: 'private-code' },
  codeVerifier: 'verifier + value',
}
const issuer = 'https://issuer.test'
const claims = { iss: issuer, aud: args.clientId, exp: 2000, sub: '123' }
const token = (value: unknown) => `header.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`
const validation = { clientId: args.clientId, issuers: [issuer], now: 1000 }

test('授权地址保留 scope，编码参数，固定 code 和 S256', () => {
  const url = new URL(
    authorizationUrl(
      'https://issuer.test/auth',
      {
        ...args,
        state: 'state + &',
        codeChallenge: 'challenge',
      },
      { scope: 'openid email', response_type: 'token', code_challenge_method: 'plain' },
    ),
  )
  expect(url.origin + url.pathname).toBe('https://issuer.test/auth')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: 'state + &',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    scope: 'openid email',
  })
  expect(
    new URL(
      authorizationUrl('https://issuer.test/auth', {
        ...args,
        state: 'state',
        codeChallenge: 'challenge',
      }),
    ).searchParams.has('scope'),
  ).toBe(false)
})

test('通过传入的 fetch 发送表单，不把回调里的其他参数发给第三方', async () => {
  const requests: Request[] = []
  const result = await exchangeCode(
    (request) => {
      requests.push(request)
      return Promise.resolve(Response.json({ access_token: 'private-token' }))
    },
    'https://issuer.test/token',
    { ...args, query: { ...args.query, unexpected: 'ignored' } },
  )
  expect(result).toEqual({ access_token: 'private-token' })
  expect(requests).toHaveLength(1)
  const request = requests[0]!
  expect(request.url).toBe('https://issuer.test/token')
  expect(request.method).toBe('POST')
  expect(request.headers.get('accept')).toBe('application/json')
  expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
  expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
    grant_type: 'authorization_code',
    code: args.query.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  })
})

test.each([{}, { code: '' }] as Readonly<Record<string, string>>[])(
  '没有授权码不发请求：%j',
  async (query: Readonly<Record<string, string>>) => {
    const fetch = vi.fn<(request: Request) => Promise<Response>>()
    await expect(exchangeCode(fetch, 'https://issuer.test/token', { ...args, query })).rejects.toThrow(
      'missing authorization code',
    )
    expect(fetch).not.toHaveBeenCalled()
  },
)

test.each(
  [null, [], 'private-token', { error: 'private-token', error_description: 'private-code' }, { error: null }].map(
    (body) => ({ body }),
  ),
)('令牌响应必须是没有 error 的对象：%j', async ({ body }) => {
  const result = exchangeCode(() => Promise.resolve(Response.json(body)), 'https://issuer.test/token', args)
  await expect(result).rejects.toThrow('invalid token response')
  await expect(result).rejects.not.toThrow(/private-code|private-token|secret/)
})

test('JSON 请求允许数组响应，便于读取邮箱列表', async () => {
  await expect(fetchJson(() => Promise.resolve(Response.json([1])), new Request(issuer), 'user')).resolves.toEqual([1])
})

test.each(['token', 'user'] as const)('隐藏 %s 请求的响应体、JSON 错误和网络异常', async (stage) => {
  const request = new Request(issuer)
  await expect(
    fetchJson(() => Promise.resolve(new Response('private-code private-token', { status: 400 })), request, stage),
  ).rejects.toThrow(`${stage} request failed: 400`)
  await expect(fetchJson(() => Promise.resolve(new Response('private-token')), request, stage)).rejects.toThrow(
    `invalid ${stage} response`,
  )
  await expect(
    fetchJson(() => Promise.reject(new Error('private-code private-token')), request, stage),
  ).rejects.toThrow(new RegExp(`^${stage} request failed$`))
})

test('ID 令牌接受字符串或数组 aud，容许三分钟时钟偏差', () => {
  expect(readIdToken(token(claims), validation)).toEqual(claims)
  expect(readIdToken(token({ ...claims, aud: ['other', args.clientId] }), validation).sub).toBe('123')
  expect(readIdToken(token({ ...claims, exp: 821 }), validation).exp).toBe(821)
  expect(
    readIdToken(token({ ...claims, exp: Date.now() / 1000 + 3600 }), {
      clientId: args.clientId,
      issuers: [issuer],
    }).sub,
  ).toBe('123')
})

test.each([
  { ...claims, iss: 'https://wrong.test' },
  { ...claims, iss: null },
  { ...claims, aud: 'wrong' },
  { ...claims, aud: ['wrong'] },
  { ...claims, aud: [args.clientId, 1] },
  { ...claims, aud: undefined },
  { ...claims, exp: 819 },
  { ...claims, exp: 820 },
  { ...claims, exp: '2000' },
  { ...claims, exp: undefined },
  { ...claims, exp: null },
])('ID 令牌拒绝不符的 iss、aud 或 exp：%j', (value) => {
  expect(() => readIdToken(token(value), validation)).toThrow('invalid ID token claims')
})

test.each([
  undefined,
  null,
  '',
  'one.two',
  'one.two.three.four',
  'header..signature',
  'header.%%%.signature',
  `header.${Buffer.from('private-token private-code').toString('base64url')}.signature`,
  token([]),
  token(null),
  token('private-token'),
])('损坏的 ID 令牌不泄露载荷：%j', (value) => {
  expect(() => readIdToken(value, validation)).toThrow('invalid ID token')
  expect(() => readIdToken(value, validation)).not.toThrow(/private-code|private-token/)
})
