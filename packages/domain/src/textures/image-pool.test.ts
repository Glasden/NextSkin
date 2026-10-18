import { readFile } from 'node:fs/promises'
import { afterEach, expect, test, vi } from 'vitest'
import { DomainError } from '../errors.ts'
import { createImagePool, type ImagePool } from './image-pool.ts'
import { decodeTexturePng, inspectTexture, processUpload, renderTexture } from './image.ts'

const pools: ImagePool[] = []
const pool = (options?: Parameters<typeof createImagePool>[0]) => {
  const value = createImagePool(options)
  pools.push(value)
  return value
}
const input = async () => ({
  bytes: new Uint8Array(await readFile(new URL('../../../skin/test/fixtures/haka.png', import.meta.url))),
  type: 'steve' as const,
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(pools.splice(0).map((p) => p.close()))
})

test('真 worker 处理 fixture、转移输入字节、复用线程、保留领域 code/params', async () => {
  const p = pool({ size: 1 }),
    task = await input(),
    expected = processUpload(task.bytes, task.type)
  const promise = p.processUpload(task)
  expect(task.bytes.byteLength).toBe(0)
  expect(await promise).toEqual(expected)
  const next = await input(),
    render = { ...next, kind: 'head' as const, k: 1 },
    rendered = renderTexture(render)
  expect(await p.render(render)).toEqual(rendered)
  await expect(p.processUpload({ bytes: new Uint8Array(), type: 'steve' })).rejects.toMatchObject({
    code: 'texture_file_invalid',
  })
  const legacy = new Uint8Array(await readFile(new URL('../../../skin/test/fixtures/sethbling.png', import.meta.url)))
  await expect(p.processUpload({ bytes: legacy, type: 'alex' })).rejects.toMatchObject({
    code: 'texture_size_invalid',
    params: { width: 64, height: 32 },
  })
  await expect(p.render({ bytes: new Uint8Array(), kind: 'head', type: 'steve', k: 1 })).rejects.toThrow('图像处理失败')
})

test('导入检查在 worker 里执行，解码不了的保留领域 code', async () => {
  const p = pool({ size: 1 }),
    task = await input(),
    expected = inspectTexture(task.bytes, task.type)
  const promise = p.inspect(task)
  expect(task.bytes.byteLength).toBe(0)
  expect(await promise).toEqual(expected)
  await expect(p.inspect({ bytes: new Uint8Array(8), type: 'steve' })).rejects.toMatchObject({
    code: 'texture_file_invalid',
  })
})

test('排队上限只计算等待任务，满队列拒绝；处理完后继续可用', async () => {
  const p = pool({ size: 1, queueLimit: 1 }),
    a = await input(),
    b = await input(),
    c = await input()
  const first = p.processUpload(a),
    second = p.processUpload(b)
  await expect(p.processUpload(c)).rejects.toEqual(new DomainError('service_unavailable'))
  await Promise.all([first, second])
  expect((await p.processUpload(await input())).width).toBe(64)
})

test('超时终止线程，换新线程并继续完成队列任务', async () => {
  const p = pool({ size: 1 }),
    a = await input(),
    b = await input()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = p.processUpload(a),
    rejected = expect(first).rejects.toEqual(new DomainError('service_unavailable'))
  const second = p.processUpload(b)
  vi.advanceTimersByTime(10_000)
  vi.useRealTimers()
  await rejected
  expect(decodeTexturePng((await second).png).width).toBe(64)
})

test('close 拒绝进行中和排队任务，且关闭后不接受新任务；空池可关闭', async () => {
  const p = pool({ size: 1 }),
    a = await input(),
    b = await input()
  const first = expect(p.processUpload(a)).rejects.toMatchObject({ code: 'service_unavailable' })
  const second = expect(p.processUpload(b)).rejects.toMatchObject({ code: 'service_unavailable' })
  await p.close()
  await Promise.all([first, second])
  await expect(p.processUpload(await input())).rejects.toMatchObject({ code: 'service_unavailable' })
  await p.close()
  await pool().close()
})
