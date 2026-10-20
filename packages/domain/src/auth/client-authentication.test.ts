import { expect, test } from 'vitest'
import { normalizeClientAuthentication, type RegisteredAuthMethod } from './client-authentication.ts'

const methods: Record<string, string | null> = {
  post: 'client_secret_post',
  basic: 'client_secret_basic',
  unset: null,
  public: 'none',
}
const lookup: RegisteredAuthMethod = (clientId) => Promise.resolve(methods[clientId])

function request(
  path: string,
  form: Record<string, string> | string,
  headers: Record<string, string> = {},
  method = 'POST',
) {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: method === 'POST' ? (typeof form === 'string' ? form : new URLSearchParams(form).toString()) : undefined,
  })
}

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`

async function normalize(input: Request) {
  const output = await normalizeClientAuthentication(input, '/api/auth', lookup)
  return {
    same: output === input,
    authorization: output.headers.get('authorization'),
    form: Object.fromEntries(new URLSearchParams(await output.text())),
  }
}

test.each(['/oauth2/token', '/oauth2/introspect', '/oauth2/revoke', '/device/code'])(
  '%s：登记为 post 的客户端用 Basic 时，改写成请求体',
  async (endpoint) => {
    const result = await normalize(
      request(`/api/auth${endpoint}`, { token: 't' }, { authorization: basic('post', 'secret') }),
    )
    expect(result).toEqual({
      same: false,
      authorization: null,
      form: { token: 't', client_id: 'post', client_secret: 'secret' },
    })
  },
)

test.each(['basic', 'unset'])('登记为 %s 的客户端在请求体里传密钥时，改写成 Basic', async (clientId) => {
  const result = await normalize(request('/api/auth/oauth2/token', { client_id: clientId, client_secret: 's' }))
  expect(result).toEqual({ same: false, authorization: basic(clientId, 's'), form: { client_id: clientId } })
})

test('scheme 不区分大小写、后面可以有多个空格，与 Better Auth 相同', async () => {
  const authorization = basic('post', 's').replace('Basic ', 'bAsIc   ')
  expect(await normalize(request('/api/auth/oauth2/token', {}, { authorization }))).toMatchObject({
    same: false,
    form: { client_id: 'post', client_secret: 's' },
  })
})

test('Basic 里的值按 application/x-www-form-urlencoded 编码（RFC 6749 §2.3.1），往返不变', async () => {
  const secret = 'a:b+c %d/é'
  const toBasic = await normalizeClientAuthentication(
    request('/api/auth/oauth2/token', { client_id: 'basic', client_secret: secret }),
    '/api/auth',
    lookup,
  )
  const encoded = Buffer.from(toBasic.headers.get('authorization')!.slice('Basic '.length), 'base64').toString()
  expect(encoded).toBe(`basic:${new URLSearchParams({ v: secret }).toString().slice(2)}`)

  methods['basic-as-post'] = 'client_secret_post'
  const back = await normalize(
    request(
      '/api/auth/oauth2/token',
      {},
      { authorization: `Basic ${Buffer.from(`basic-as-post:${encoded.slice(6)}`).toString('base64')}` },
    ),
  )
  expect(back.form.client_secret).toBe(secret)
})

test.each([
  ['登记方式已经匹配（post 用请求体）', request('/api/auth/oauth2/token', { client_id: 'post', client_secret: 's' })],
  ['登记方式已经匹配（basic 用 Basic）', request('/api/auth/oauth2/token', {}, { authorization: basic('basic', 's') })],
  ['公共客户端', request('/api/auth/oauth2/token', { client_id: 'public', client_secret: 's' })],
  ['客户端不存在', request('/api/auth/oauth2/token', { client_id: 'missing', client_secret: 's' })],
  ['同时用两种方式', request('/api/auth/oauth2/token', { client_secret: 's' }, { authorization: basic('post', 's') })],
  [
    'Basic 与请求体的 client_id 不同',
    request('/api/auth/oauth2/token', { client_id: 'other' }, { authorization: basic('post', 's') }),
  ],
  ['参数重复', request('/api/auth/oauth2/token', 'client_id=basic&client_secret=a&client_secret=b')],
  [
    '带 client_assertion',
    request('/api/auth/oauth2/token', { client_id: 'basic', client_secret: 's', client_assertion: 'x' }),
  ],
  ['Bearer 认证头', request('/api/auth/oauth2/token', {}, { authorization: 'Bearer abc' })],
  // Better Auth 只接受 scheme 后面跟空格的写法，它会拒绝的请求，改写后不能变成能通过（独立审核发现）
  [
    'Basic 后面跟制表符',
    request('/api/auth/oauth2/token', {}, { authorization: basic('post', 's').replace(' ', '\t') }),
  ],
  ['其他端点', request('/api/auth/oauth2/consent', { client_id: 'basic', client_secret: 's' })],
  ['其他挂载路径', request('/other/oauth2/token', { client_id: 'basic', client_secret: 's' })],
  ['GET', request('/api/auth/oauth2/token', {}, {}, 'GET')],
  [
    'JSON 请求体',
    new Request('http://127.0.0.1:3000/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'basic', client_secret: 's' }),
    }),
  ],
])('%s：原样交给 Better Auth', async (_, input) => {
  expect((await normalize(input)).same).toBe(true)
})
