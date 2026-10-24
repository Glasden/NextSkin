import { expect, test, vi } from 'vitest'
import { MANIFEST_URL } from '@nextskin/updates'
import { fetchUpdateManifest } from './manifest.ts'
import { initialUpdateState, storedUpdateState, updateStateSchema } from './state.ts'

const fetchWith = (response: Response) => vi.fn<typeof fetch>().mockResolvedValue(response)
test('固定 GET 地址，禁重定向、Cookie，无查询参数或自定义头，有超时信号', async () => {
  const fetcher = fetchWith(new Response('{"schema":1,"releases":[]}'))
  expect(await fetchUpdateManifest({ fetch: fetcher })).toEqual({ releases: [], rejected: 0 })
  const signal = fetcher.mock.calls[0]![1]!.signal
  expect(signal).toBeInstanceOf(AbortSignal)
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(MANIFEST_URL, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    signal,
  })
})
test.each(['{', '{}', '{"schema":2,"releases":[]}'])('非法 JSON 或清单结构 %s', async (body) => {
  expect(await fetchUpdateManifest({ fetch: fetchWith(new Response(body)) })).toEqual({ failure: { code: 'invalid' } })
})
test('网络和读流错误都只留下 network', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('untrusted'))
  expect(await fetchUpdateManifest({ fetch: fetcher })).toEqual({ failure: { code: 'network' } })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('untrusted'))
    },
  })
  expect(await fetchUpdateManifest({ fetch: fetchWith(new Response(stream)) })).toEqual({
    failure: { code: 'network' },
  })
})
test('非 2xx 只保留状态码并取消响应体', async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream({ cancel })
  expect(await fetchUpdateManifest({ fetch: fetchWith(new Response(stream, { status: 503 })) })).toEqual({
    failure: { code: 'http', status: 503 },
  })
  expect(cancel).toHaveBeenCalledOnce()
})
test('按流的实际字节数限制 1 MiB，忽略伪造的 Content-Length，超限取消流和请求', async () => {
  let sent = 0
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent++
      controller.enqueue(new Uint8Array(600_000))
    },
    cancel,
  })
  const fetcher = fetchWith(new Response(stream, { headers: { 'content-length': '1' } }))
  expect(await fetchUpdateManifest({ fetch: fetcher })).toEqual({ failure: { code: 'too_large' } })
  expect(cancel).toHaveBeenCalledOnce()
  expect(sent).toBeLessThanOrEqual(3)
  expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true)
})
test('正好 1 MiB 的合法清单可读，无响应体为 invalid', async () => {
  const body = '{"schema":1,"releases":[]}'
  expect(await fetchUpdateManifest({ fetch: fetchWith(new Response(body.padEnd(1024 * 1024))) })).toEqual({
    releases: [],
    rejected: 0,
  })
  expect(await fetchUpdateManifest({ fetch: fetchWith(new Response(null)) })).toEqual({ failure: { code: 'invalid' } })
})
test('请求使用 15 秒超时', async () => {
  const signal = new AbortController().signal
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
  try {
    await fetchUpdateManifest({ fetch: fetchWith(new Response('{"schema":1,"releases":[]}')) })
    expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000)
  } finally {
    timeout.mockRestore()
  }
})
test('状态 schema 严格约束内部字段、错误状态码、版本和通知列表；读出时不合格的当作没检查过', () => {
  expect(storedUpdateState.parse(initialUpdateState)).toEqual(initialUpdateState)
  for (const patch of [
    { extra: true },
    { checkedAt: 'yesterday' },
    { failure: { at: '2026-10-23T00:00:00Z', code: 'unknown' } },
    { failure: { at: '2026-10-23T00:00:00Z', code: 'network', status: 500 } },
    { failure: { at: '2026-10-23T00:00:00Z', code: 'http' } },
    { rejected: -1 },
    { notified: ['1.0.0', '1.0.0'] },
    { notified: ['1.0.0-rc.1'] },
    { notified: Array.from({ length: 21 }, (_, i) => `1.0.${i}`) },
    { releases: [{ version: '1.0.0', date: 'invalid', notes: 'http://example.test', minNode: 0, managerProtocol: 1 }] },
    {
      releases: [
        {
          version: '1.0.0',
          date: '2026-10-23T00:00:00Z',
          notes: 'https://example.test',
          minNode: 24,
          managerProtocol: 0,
        },
      ],
    },
    {
      releases: Array.from({ length: 21 }, (_, i) => ({
        version: `1.0.${i}`,
        date: '2026-10-23T00:00:00Z',
        notes: 'https://example.test',
        minNode: 24,
        managerProtocol: i + 1,
      })),
    },
  ]) {
    expect(storedUpdateState.safeParse({ ...initialUpdateState, ...patch }).success).toBe(false)
    expect(updateStateSchema.parse({ ...initialUpdateState, checkedAt: '2026-10-23T00:00:00Z', ...patch })).toEqual(
      initialUpdateState,
    )
  }
})
