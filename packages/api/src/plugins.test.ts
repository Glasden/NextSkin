import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { official, pluginEnvironment } from '../../domain/src/plugins/plugins.test-helper.ts'
import { definePlugin } from '../../plugin-sdk/src/index.ts'
import { createApp } from './app.ts'
import { errorSchema } from './rest/errors.ts'

const env = pluginEnvironment()
const origin = 'https://skin.example.test'
let app: ReturnType<typeof createApp>
let session: Awaited<ReturnType<typeof env.core.auth.getSessionUser>>
let actor: Awaited<ReturnType<typeof env.actor>>
const echo = async ({ request }: { request: Request }) =>
  Response.json({
    url: request.url,
    method: request.method,
    cookie: request.headers.get('cookie'),
    authorization: request.headers.get('authorization'),
    proxyAuthorization: request.headers.get('proxy-authorization'),
    header: request.headers.get('x-custom'),
    body: await request.text(),
  })

beforeEach(async () => {
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        permissions: { manage: 'manage' },
        routes: {
          'GET /': { auth: 'public', handler: () => Promise.resolve(new Response('root')) },
          'GET /hello/:name': {
            auth: 'public',
            handler: ({ params }) => Promise.resolve(new Response(params.name, { status: 202 })),
          },
          'GET /user': { auth: 'user', handler: echo },
          'GET /manage': { auth: 'user', permission: 'manage', handler: echo },
          'POST /user': { auth: 'user', handler: echo },
          'POST /public': { auth: 'public', handler: echo },
          'POST /small': { auth: 'public', maxBodyBytes: 4, handler: echo },
          'GET /by-user': {
            auth: 'user',
            rateLimit: { limit: 2, windowSec: 60, by: 'user' },
            handler: echo,
          },
          'GET /by-ip': {
            auth: 'public',
            rateLimit: { limit: 2, windowSec: 60, by: 'ip' },
            handler: echo,
          },
          'GET /headers': {
            auth: 'public',
            handler: () =>
              Promise.resolve(
                new Response('<script>alert(1)</script>', {
                  headers: {
                    'set-cookie': 'plugin=forbidden',
                    connection: 'keep-alive',
                    'keep-alive': 'timeout=60',
                    'transfer-encoding': 'chunked',
                    'content-length': '999',
                    'content-security-policy': "default-src *; script-src 'unsafe-inline'",
                    'content-security-policy-report-only': 'default-src *',
                    'x-content-type-options': 'unsafe',
                    'clear-site-data': '"*"',
                    'access-control-allow-credentials': 'true',
                    'x-plugin': 'kept',
                  },
                }),
              ),
          },
          'GET /cached': {
            auth: 'public',
            handler: () =>
              Promise.resolve(new Response('cached', { headers: { 'cache-control': 'public, max-age=60' } })),
          },
          'GET /user-cached': {
            auth: 'user',
            handler: () =>
              Promise.resolve(new Response('mine', { headers: { 'cache-control': 'public, max-age=60' } })),
          },
          'GET /throw': { auth: 'public', handler: () => Promise.reject(new Error('plugin failure')) },
        },
      }),
    ),
  ])
  actor = await env.actor()
  await env.core.plugins.admin.enable(actor, 'a')
  session = null
  vi.spyOn(env.core.auth, 'getSessionUser').mockImplementation(() => Promise.resolve(session))
  app = createApp({ core: env.core })
})
afterEach(() => vi.restoreAllMocks())

function signIn(role: 'user' | 'banned' | 'admin' = 'user', uid = actor.uid) {
  session = { uid, role, nickname: 'Session', email: 'session@example.test', locale: null }
}
function request(path: string, init: RequestInit = {}, peer = '192.0.2.10') {
  const headers = new Headers(init.headers)
  headers.set('host', 'skin.example.test')
  headers.set('x-forwarded-proto', 'https')
  return app.request(`${origin}${path}`, { ...init, headers }, { peer })
}
async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(errorSchema.parse(await response.json()).error.code).toBe(code)
}

test.each([
  ['GET', '/plugins/missing/hello/name'],
  ['GET', '/plugins/a/missing'],
  ['POST', '/plugins/a/hello/name'],
])('未知插件、未匹配路径或方法返回 JSON 404：%s %s', async (method, path) => {
  await failure(await request(path, { method }), 404, 'plugin_route_not_found')
})

test('停用插件后原有路由返回 JSON 404', async () => {
  expect((await request('/plugins/a/hello/name')).status).toBe(202)
  await env.core.plugins.admin.disable(actor, 'a')
  await failure(await request('/plugins/a/hello/name'), 404, 'plugin_route_not_found')
})

test.each([
  [null, '/user', 401, 'unauthenticated'],
  ['banned', '/user', 403, 'user_banned'],
  ['user', '/manage', 403, 'permission_denied'],
] as const)('用户路由：%s 访问 %s 返回 %s', async (role, path, status, code) => {
  if (role) signIn(role)
  await failure(await request(`/plugins/a${path}`), status, code)
})

test.each(['user', 'admin'] as const)('%s 可以访问有权限的路由', async (role) => {
  signIn(role)
  const response = await request(`/plugins/a/${role === 'admin' ? 'manage' : 'user'}`)
  expect(response.status).toBe(200)
})

test.each([undefined, 'https://other.test', 'null'])('会话写请求拒绝不匹配的 Origin：%s', async (value) => {
  signIn()
  await failure(
    await request('/plugins/a/user', {
      method: 'POST',
      headers: { cookie: 'session=example', ...(value === undefined ? {} : { origin: value }) },
      body: 'body',
    }),
    403,
    'invalid_origin',
  )
})

test('Origin 匹配时转发公开 URL、查询串和请求体，剥离 Cookie 和认证头，保留普通头', async () => {
  signIn()
  // 模拟 Next 的内部监听地址；插件必须看到 Host 和代理协议还原的公开地址。
  const response = await app.request(
    'http://127.0.0.1:3000/plugins/a/user?q=a%20b&n=2',
    {
      method: 'POST',
      headers: {
        origin,
        host: 'skin.example.test',
        'x-forwarded-proto': 'https',
        cookie: 'session=example',
        authorization: 'Bearer example',
        'proxy-authorization': 'Basic ZXhhbXBsZQ==',
        'x-custom': 'kept',
      },
      body: '你好',
    },
    { peer: '192.0.2.10' },
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    url: `${origin}/plugins/a/user?q=a%20b&n=2`,
    method: 'POST',
    cookie: null,
    authorization: null,
    proxyAuthorization: null,
    header: 'kept',
    body: '你好',
  })
})

test('public 写路由不读取会话、不校验 Origin，仍剥离 Cookie', async () => {
  const getSession = vi.spyOn(env.core.auth, 'getSessionUser')
  signIn('banned')
  const response = await request('/plugins/a/public', {
    method: 'POST',
    headers: { origin: 'https://other.test', cookie: 'session=example' },
    body: 'public',
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ cookie: null, body: 'public' })
  expect(getSession).not.toHaveBeenCalled()
})

test('Content-Length 声明超过路由上限时拒绝，插件不被调用', async () => {
  const route = vi.spyOn(env.core.plugins, 'route')
  await failure(
    await request('/plugins/a/small', {
      method: 'POST',
      headers: { 'content-length': '5' },
      body: 'a',
    }),
    413,
    'request_too_large',
  )
  expect(route).not.toHaveBeenCalled()
})

test('无 Content-Length 的流式请求按 UTF-8 字节数限额', async () => {
  const route = vi.spyOn(env.core.plugins, 'route')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('你'))
      controller.enqueue(new TextEncoder().encode('好'))
      controller.close()
    },
  })
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' }
  await failure(await request('/plugins/a/small', init), 413, 'request_too_large')
  expect(route).not.toHaveBeenCalled()
})

test('请求体恰好达到 maxBodyBytes 可以完整交给插件', async () => {
  const response = await request('/plugins/a/small', { method: 'POST', body: '1234' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ body: '1234' })
})

test('by:user 同一用户跨 IP 共享限额，不同用户独立', async () => {
  signIn()
  expect((await request('/plugins/a/by-user')).status).toBe(200)
  expect((await request('/plugins/a/by-user', {}, '192.0.2.11')).status).toBe(200)
  const limited = await request('/plugins/a/by-user', {}, '192.0.2.12')
  await failure(limited, 429, 'too_many_requests')
  expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  signIn('user', actor.uid + 1)
  expect((await request('/plugins/a/by-user')).status).toBe(200)
})

test('by:ip 同 IP 共享限额，不可信 XFF 不能绕过，不同 IP 独立', async () => {
  expect((await request('/plugins/a/by-ip')).status).toBe(200)
  expect((await request('/plugins/a/by-ip', { headers: { 'x-forwarded-for': '198.51.100.1' } })).status).toBe(200)
  const limited = await request('/plugins/a/by-ip', { headers: { 'x-forwarded-for': '198.51.100.2' } })
  await failure(limited, 429, 'too_many_requests')
  expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  expect((await request('/plugins/a/by-ip', {}, '192.0.2.11')).status).toBe(200)
})

test('by:ip 在可信代理后按客户端 IP 计数', async () => {
  await env.core.admin.updateSettings(actor, { 'network.trustedProxies': ['192.0.2.10'] })
  const headers = { 'x-forwarded-for': '198.51.100.20' }
  expect((await request('/plugins/a/by-ip', { headers })).status).toBe(200)
  expect((await request('/plugins/a/by-ip', { headers })).status).toBe(200)
  await failure(await request('/plugins/a/by-ip', { headers }), 429, 'too_many_requests')
  expect((await request('/plugins/a/by-ip', { headers: { 'x-forwarded-for': '198.51.100.21' } })).status).toBe(200)
})

test.each(['/plugins/a/hello/%E4%BD%A0%E5%A5%BD', '/plugins/a/hello/%E4%BD%A0%E5%A5%BD/'])(
  '路径参数解码，末尾斜杠等价：%s',
  async (path) => {
    const response = await request(path)
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('你好')
  },
)

test.each(['/plugins/a', '/plugins/a/'])('插件根路径末尾斜杠等价：%s', async (path) => {
  const response = await request(path)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('root')
})

test('响应剥离危险头、覆盖 CSP 和 nosniff，默认禁止缓存', async () => {
  const response = await request('/plugins/a/headers')
  expect(response.status).toBe(200)
  for (const name of [
    'set-cookie',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-length',
    'content-security-policy-report-only',
    'clear-site-data',
    'access-control-allow-credentials',
  ])
    expect(response.headers.get(name), name).toBeNull()
  expect(response.headers.get('content-security-policy')).toBe(
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  )
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-plugin')).toBe('kept')
  expect(await response.text()).toBe('<script>alert(1)</script>')
})

test('保留插件显式 Cache-Control，同时添加安全头', async () => {
  const response = await request('/plugins/a/cached')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('public, max-age=60')
  expect(response.headers.get('content-security-policy')).toContain('sandbox')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
})

test('要登录的路由一律禁止缓存，插件设的 Cache-Control 不算数', async () => {
  signIn()
  const response = await request('/plugins/a/user-cached')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
})

test('HEAD 使用 GET 路由并去掉响应体', async () => {
  const route = vi.spyOn(env.core.plugins, 'route')
  const response = await request('/plugins/a/hello/name', { method: 'HEAD' })
  expect(response.status).toBe(202)
  expect(response.body).toBeNull()
  expect(await response.text()).toBe('')
  expect(route).toHaveBeenCalledOnce()
  expect(route.mock.calls[0]![0]).toMatchObject({ method: 'GET', request: { method: 'GET' } })
})

test('插件抛错映射成 502 plugin_error', async () => {
  await failure(await request('/plugins/a/throw'), 502, 'plugin_error')
})

test('插件序列化响应含非法头名时返回 502', async () => {
  // Response 构造器本身拒绝非法头名，直接在插件调用的序列化响应边界注入。
  vi.spyOn(env.core.plugins, 'route').mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: [['bad header', 'value']],
    body: null,
  })
  await failure(await request('/plugins/a/cached'), 502, 'plugin_error')
})

test('插件序列化响应超过 10 MiB 时返回 502', async () => {
  vi.spyOn(env.core.plugins, 'route').mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: [],
    body: new Uint8Array(10 * 1024 * 1024 + 1),
  })
  await failure(await request('/plugins/a/cached'), 502, 'plugin_error')
})
