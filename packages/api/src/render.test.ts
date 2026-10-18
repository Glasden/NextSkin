import { DomainError, RENDERER_VERSION, type Core } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from './app.ts'

const hash = 'a'.repeat(64),
  bytes = Uint8Array.of(137, 80, 78, 71)
const path = (part = `figure/alex/1/${hash}.png`) => `/render/v${RENDERER_VERSION}/${part}`
function setup() {
  const figure = vi.fn().mockResolvedValue(bytes),
    head = vi.fn().mockResolvedValue(bytes)
  const core = {
    settings: { read: vi.fn().mockResolvedValue({ 'yggdrasil.apiLocationIndication': true }) },
    renders: { figure, head },
  } as unknown as Core
  return { app: createApp({ core }), figure, head }
}

test.each(['figure/steve', 'figure/alex', 'figure/cape', 'head'])(
  'GET/HEAD %s：内容、长度、不可变缓存和一个 ALI',
  async (kind) => {
    const { app, figure, head } = setup(),
      url = path(`${kind}/1/${hash}.png`)
    for (const method of ['GET', 'HEAD']) {
      const response = await app.request(url, { method })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('content-length')).toBe('4')
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(response.headers.get('x-authlib-injector-api-location')).toBe('http://localhost/api/yggdrasil')
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(method === 'HEAD' ? new Uint8Array() : bytes)
    }
    if (kind === 'head') {
      expect(head).toHaveBeenCalledWith({ hash, k: 1 })
      expect(figure).not.toHaveBeenCalled()
    } else expect(figure).toHaveBeenCalledWith({ hash, model: kind.slice(7), k: 1 })
  },
)

test.each([
  `/render/v0/head/1/${hash}.png`,
  `/render/v01/head/1/${hash}.png`,
  `/render/v${RENDERER_VERSION + 1}/head/1/${hash}.png`,
  path(`figure/unknown/1/${hash}.png`),
  path(`figure/alex/01/${hash}.png`),
  path(`figure/alex/0/${hash}.png`),
  path(`head/-1/${hash}.png`),
  path(`head/1.0/${hash}.png`),
  path(`head/10000/${hash}.png`),
  path(`head/1/${hash.toUpperCase()}.png`),
  path(`head/1/${hash}.jpg`),
  path('head/1/abc.png'),
  path(`head/1/${hash}%2F.png`),
  path(`figure/alex/1/${hash}.png%2F`),
])('不合法路径直接 404，不触发领域查询：%s', async (url) => {
  const { app, figure, head } = setup()
  for (const method of ['GET', 'HEAD', 'POST']) {
    const response = await app.request(url, { method })
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-cache, private')
  }
  expect(figure).not.toHaveBeenCalled()
  expect(head).not.toHaveBeenCalled()
})

test('合法 k 范围包含 9999，其他 HTTP 方法返回 405 / Allow', async () => {
  const { app, figure } = setup()
  expect((await app.request(path(`figure/steve/9999/${hash}.png`))).status).toBe(200)
  expect(figure).toHaveBeenCalledWith({ hash, model: 'steve', k: 9999 })
  figure.mockClear()
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const response = await app.request(path(), { method })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(response.headers.get('cache-control')).toBe('no-cache, private')
  }
  expect(figure).not.toHaveBeenCalled()
})

test('领域层 null 返回 404，池饱和/超时返回 503 + Retry-After: 5，默认私有缓存', async () => {
  const { app, figure, head } = setup()
  for (const fn of [figure, head]) {
    const url = fn === figure ? path() : path(`head/1/${hash}.png`)
    fn.mockResolvedValueOnce(null)
    const missing = await app.request(url)
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('Not Found')
    expect(missing.headers.get('cache-control')).toBe('no-cache, private')
    fn.mockRejectedValueOnce(new DomainError('service_unavailable'))
    const full = await app.request(url)
    expect(full.status).toBe(503)
    expect(full.headers.get('retry-after')).toBe('5')
    expect(full.headers.get('cache-control')).toBe('no-cache, private')
    fn.mockRejectedValueOnce(new Error('private internal detail'))
    const error = await app.request(url)
    expect(error.status).toBe(500)
    expect(await error.text()).toBe('Internal Server Error')
  }
})
