import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import { download, extract } from './archive.ts'
import { fixture, releaseZip, signedManifest, zipResponse } from './fixtures.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})
async function setup() {
  const f = await fixture()
  disposers.push(f.dispose)
  return f
}
async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('ZIP 下载', () => {
  it('SHA-256 不符时改用第二个地址，跳转允许 follow', async () => {
    const f = await setup()
    const zip = releaseZip('1.1.0')
    const { entry } = signedManifest(zip)
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(zipResponse(new Uint8Array(zip.length)))
      .mockResolvedValueOnce(zipResponse(zip))
    const destination = join(f.home, 'releases/.staging/download.zip')
    await download(entry, destination, { fetch: fetcher })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('follow')
    expect(
      createHash('sha256')
        .update(await readFile(destination))
        .digest('hex'),
    ).toBe(entry.sha256)
  })
  it('超过声明 size 时中止读取、清除文件并尝试备用地址', async () => {
    const f = await setup()
    const { entry } = signedManifest(new Uint8Array([1]))
    const cancel = vi.fn()
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]))
            },
            cancel,
          }),
        ),
      ),
    )
    const destination = join(f.home, 'too-big.zip')
    await expect(download(entry, destination, { fetch: fetcher })).rejects.toThrow('所有下载地址')
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(await exists(destination)).toBe(false)
    expect(fetcher.mock.calls.every((call) => call[1]?.signal?.aborted)).toBe(true)
  })
  it('连接超时换下一个渠道，用户取消后不重试', async () => {
    const f = await setup()
    const zip = releaseZip('1.1.0')
    const { entry } = signedManifest(zip)
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_input, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
          }),
      )
      .mockResolvedValueOnce(zipResponse(zip))
    await download(entry, join(f.home, 'ok.zip'), { fetch: fetcher, connectionTimeout: 5 })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const controller = new AbortController()
    controller.abort()
    await expect(
      download(entry, join(f.home, 'cancel.zip'), { fetch: fetcher, signal: controller.signal }),
    ).rejects.toBeDefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('逐条解压', () => {
  it('只取目标版本和 manager，不碰实例文件和其他版本', async () => {
    const f = await setup()
    const zip = releaseZip('1.1.0', {
      'nextskin/data/should-not-extract': strToU8('data'),
      'nextskin/releases/8.0.0/server/VERSION': strToU8('8.0.0'),
      'nextskin/nextskin.mjs': strToU8('root'),
    })
    const path = join(f.home, 'test.zip')
    await writeFile(path, zip)
    await extract(f.home, '1.1.0', path, ['1.0.0', null])
    expect(await readFile(join(f.home, 'releases/1.1.0/server/VERSION'), 'utf8')).toBe('1.1.0')
    expect(await readFile(join(f.home, 'releases/.staging/manager-1.1.0/VERSION'), 'utf8')).toBe('1.1.0')
    expect(await readdir(join(f.home, 'data'))).toEqual(['db.sqlite'])
    expect(await exists(join(f.home, 'releases/8.0.0'))).toBe(false)
    expect(await exists(join(f.home, 'nextskin.mjs'))).toBe(false)
  })
  it.each([
    '../outside',
    '/absolute',
    'nextskin/../escape',
    'C:/windows',
    'nextskin\\escape',
    'nextskin/manager/file:stream',
  ])('拒绝路径 %s（包括不提取的条目）', async (name) => {
    const f = await setup()
    const path = join(f.home, 'bad.zip')
    await writeFile(path, releaseZip('1.1.0', { [name]: strToU8('bad') }))
    await expect(extract(f.home, '1.1.0', path, ['1.0.0'])).rejects.toThrow('不安全路径')
  })
  it('拒绝 Unix 符号链接，即使链接在不提取的部分', async () => {
    const f = await setup()
    const path = join(f.home, 'link.zip')
    const zip = zipSync({ link: [strToU8('target'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] })
    await writeFile(path, zip)
    await expect(extract(f.home, '1.1.0', path, ['1.0.0'])).rejects.toThrow('符号链接')
  })
  it('不能覆盖 current 或 previous，版本标记错误不能发布', async () => {
    const f = await setup()
    const path = join(f.home, 'bad.zip')
    await writeFile(path, releaseZip('1.1.0', { 'nextskin/releases/1.1.0/server/VERSION': strToU8('9.9.9') }))
    await expect(extract(f.home, '1.1.0', path, ['1.1.0'])).rejects.toThrow('current 或 previous')
    await expect(extract(f.home, '1.1.0', path, ['1.0.0'])).rejects.toThrow('版本标记')
    expect(await readFile(join(f.home, 'releases/1.1.0/server/VERSION'), 'utf8')).toBe('1.1.0')
  })
  it('解压可取消，截断 ZIP 不接受', async () => {
    const f = await setup()
    const path = join(f.home, 'bad.zip')
    await writeFile(path, releaseZip('1.1.0'))
    const controller = new AbortController()
    controller.abort()
    await expect(extract(f.home, '1.1.0', path, ['1.0.0'], controller.signal)).rejects.toBeDefined()
    await writeFile(path, releaseZip('1.1.0').slice(0, 50))
    await expect(extract(f.home, '1.1.0', path, ['1.0.0'])).rejects.toThrow('中央目录')
  })
})

it('下载 body 阶段取消会中止 reader，不等待整体超时', async () => {
  const f = await setup()
  const { entry } = signedManifest(new Uint8Array([1, 2]))
  const controller = new AbortController()
  let ready!: () => void
  const started = new Promise<void>((r) => {
    ready = r
  })
  const cancel = vi.fn()
  const fetcher = vi.fn<typeof fetch>(() => {
    ready()
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1]))
          },
          cancel,
        }),
      ),
    )
  })
  const downloading = download(entry, join(f.home, 'body.zip'), { fetch: fetcher, signal: controller.signal })
  const rejected = expect(downloading).rejects.toThrow('取消')
  await started
  // 让下载器完成打开文件并开始读取 body。
  await new Promise((r) => setTimeout(r, 20))
  controller.abort()
  await rejected
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledTimes(1)
})
