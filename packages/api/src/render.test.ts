import {
  DomainError,
  MAX_HEAD_DENSITY,
  MAX_POSE_DENSITY,
  POSE_KINDS,
  RENDERER_VERSION,
  type Core,
} from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from './app.ts'

const hash = 'a'.repeat(64),
  bytes = Uint8Array.of(137, 80, 78, 71)
const path = (part = `figure/alex/1/${hash}.png`) => `/render/v${RENDERER_VERSION}/${part}`
function setup() {
  const figure = vi.fn().mockResolvedValue(bytes),
    head = vi.fn().mockResolvedValue(bytes),
    pose = vi.fn().mockResolvedValue(bytes)
  const core = {
    settings: { read: vi.fn().mockResolvedValue({ 'yggdrasil.apiLocationIndication': true }) },
    renders: { figure, head, pose },
  } as unknown as Core
  return { app: createApp({ core }), figure, head, pose }
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
      expect(head).toHaveBeenCalledWith({ hash, p: 1 })
      expect(figure).not.toHaveBeenCalled()
    } else expect(figure).toHaveBeenCalledWith({ hash, model: kind.slice(7), k: 1 })
  },
)

test.each(POSE_KINDS)('GET/HEAD %s：按模型和密度调用领域层，响应头和 figure 一致', async (kind) => {
  const { app, figure, head, pose } = setup()
  for (const model of ['steve', 'alex']) {
    for (const p of [1, 3, MAX_POSE_DENSITY]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await app.request(path(`${kind}/${model}/${p}/${hash}.png`), { method })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(response.headers.get('content-length')).toBe(String(bytes.length))
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
        expect(response.headers.get('x-authlib-injector-api-location')).toBe('http://localhost/api/yggdrasil')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(method === 'HEAD' ? new Uint8Array() : bytes)
        expect(pose).toHaveBeenLastCalledWith({ hash, kind, model, p })
      }
    }
  }
  expect(figure).not.toHaveBeenCalled()
  expect(head).not.toHaveBeenCalled()
})

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
  path(`head/${MAX_HEAD_DENSITY + 1}/${hash}.png`),
  path(`head/0/${hash}.png`),
  path(`head/1/${hash.toUpperCase()}.png`),
  path(`head/1/${hash}.jpg`),
  path('head/1/abc.png'),
  path(`head/1/${hash}%2F.png`),
  path(`figure/alex/1/${hash}.png%2F`),
  path(`unknown/alex/1/${hash}.png`),
  path(`head/alex/1/${hash}.png`),
  ...POSE_KINDS.flatMap((kind) => [
    ...['cape', 'unknown', 'Steve'].map((model) => path(`${kind}/${model}/1/${hash}.png`)),
    ...['0', String(MAX_POSE_DENSITY + 1), '01', '-1', '1.0', 'NaN', 'abc'].map((p) =>
      path(`${kind}/alex/${p}/${hash}.png`),
    ),
    path(`${kind}/alex/1/${hash.toUpperCase()}.png`),
    path(`${kind}/alex/1/${hash}.jpg`),
    path(`${kind}/1/${hash}.png`),
    `/render/v${RENDERER_VERSION + 1}/${kind}/alex/1/${hash}.png`,
  ]),
])('不合法路径直接 404，不触发领域查询：%s', async (url) => {
  const { app, figure, head, pose } = setup()
  for (const method of ['GET', 'HEAD', 'POST']) {
    const response = await app.request(url, { method })
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-cache, private')
  }
  expect(figure).not.toHaveBeenCalled()
  expect(head).not.toHaveBeenCalled()
  expect(pose).not.toHaveBeenCalled()
})

test('合法 k 范围包含 9999，头像密度到上限为止，其他 HTTP 方法返回 405 / Allow', async () => {
  const { app, figure, head } = setup()
  expect((await app.request(path(`figure/steve/9999/${hash}.png`))).status).toBe(200)
  expect(figure).toHaveBeenCalledWith({ hash, model: 'steve', k: 9999 })
  expect((await app.request(path(`head/${MAX_HEAD_DENSITY}/${hash}.png`))).status).toBe(200)
  expect(head).toHaveBeenCalledWith({ hash, p: MAX_HEAD_DENSITY })
  figure.mockClear()
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const response = await app.request(path(), { method })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(response.headers.get('cache-control')).toBe('no-cache, private')
  }
  expect(figure).not.toHaveBeenCalled()
})

test.each(POSE_KINDS)('%s 其他 HTTP 方法返回 405 / Allow，不触发出图', async (kind) => {
  const { app, pose } = setup()
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const response = await app.request(path(`${kind}/alex/3/${hash}.png`), { method })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(response.headers.get('cache-control')).toBe('no-cache, private')
  }
  expect(pose).not.toHaveBeenCalled()
})

test('领域层 null 返回 404，池饱和/超时返回 503 + Retry-After: 5，默认私有缓存', async () => {
  const { app, figure, head, pose } = setup()
  for (const [fn, url] of [
    [figure, path()],
    [head, path(`head/1/${hash}.png`)],
    ...POSE_KINDS.map((kind) => [pose, path(`${kind}/alex/3/${hash}.png`)] as const),
  ] as const) {
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
