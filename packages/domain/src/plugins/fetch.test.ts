import type { SerializedRequest } from '@nextskin/plugin-host'
import { expect, test, vi } from 'vitest'
import { PluginCallRejected } from './errors.ts'
import { MAX_FETCH_BYTES, pluginFetch } from './fetch.ts'

const network = ['https://api.example.test']
const request = (overrides: Partial<SerializedRequest> = {}): SerializedRequest => ({
  method: 'GET',
  url: `${network[0]}/start`,
  headers: [],
  body: null,
  ...overrides,
})
const options = (fetch: typeof globalThis.fetch) => ({ network, signal: new AbortController().signal, fetch })

test.each(['https://evil.example.test', 'http://api.example.test', 'https://name:password@api.example.test'])(
  '拒绝未授权 URL %s，且不发请求',
  async (url) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(pluginFetch(request({ url }), options(fetch))).rejects.toBeInstanceOf(PluginCallRejected)
    expect(fetch).not.toHaveBeenCalled()
  },
)

test('每一跳重新检查 origin', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example.test' } }))
  await expect(pluginFetch(request(), options(fetch))).rejects.toBeInstanceOf(PluginCallRejected)
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('最多跟随五跳重定向', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() => Promise.resolve(new Response(null, { status: 307, headers: { location: '/again' } })))
  await expect(pluginFetch(request(), options(fetch))).rejects.toThrow('重定向次数太多')
  expect(fetch).toHaveBeenCalledTimes(6)
})

test('303 将 POST 改成无请求体的 GET', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: '/done' } }))
    .mockResolvedValueOnce(new Response('ok', { status: 201 }))
  const result = await pluginFetch(
    request({ method: 'POST', body: new Uint8Array([1]), headers: [['content-type', 'application/json']] }),
    options(fetch),
  )
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: new Uint8Array([1]), redirect: 'manual' })
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', body: null })
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has('content-type')).toBe(false)
  expect(result.status).toBe(201)
  expect(new TextDecoder().decode(result.body)).toBe('ok')
})

test('响应体超过 10 MiB 时拒绝', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new Uint8Array(MAX_FETCH_BYTES + 1)))
  await expect(pluginFetch(request(), options(fetch))).rejects.toThrow('响应体太大')
})

test('底层错误只返回错误名，不泄露消息', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('PRIVATE_PROXY_ADDRESS'))
  await expect(pluginFetch(request(), options(fetch))).rejects.toMatchObject({
    name: 'PluginCallRejected',
    message: '出站请求失败（TypeError）',
  })
})
