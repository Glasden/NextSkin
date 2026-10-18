import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RENDERER_VERSION } from '@nextskin/skin'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createLocalRenderCache, createMemoryRenderCache, type RenderCache, type RenderKey } from './render-cache.ts'

let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nextskin-cache-'))
})
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})
const key: RenderKey = { hash: 'a'.repeat(64), kind: 'figure', model: 'alex', k: 1 }
async function verify(cache: RenderCache) {
  const bytes = Uint8Array.of(1, 2, 3),
    another = { ...key, hash: 'b'.repeat(64) }
  expect(await cache.get(key)).toBeNull()
  await Promise.all([cache.put(key, bytes), cache.put({ ...key, kind: 'head' }, bytes), cache.put(another, bytes)])
  expect(new Uint8Array((await cache.get(key))!)).toEqual(bytes)
  await cache.deleteHash(key.hash)
  expect(await cache.get(key)).toBeNull()
  expect(await cache.get({ ...key, kind: 'head' })).toBeNull()
  expect(new Uint8Array((await cache.get(another))!)).toEqual(bytes)
  await cache.deleteHash(key.hash)
  await cache.pruneOtherVersions()
  await expect(cache.get({ ...key, hash: '../outside' })).rejects.toThrow()
  await expect(cache.put({ ...key, model: '../outside' as 'alex' }, bytes)).rejects.toThrow()
}
test('本地缓存：完整键、临时文件改名、按 hash 删除、保留其他 hash', async () => {
  await verify(createLocalRenderCache(directory))
  expect(await readdir(join(directory, `v${RENDERER_VERSION}`, 'b'.repeat(64)))).toEqual(['figure-alex-1.png'])
})
test('内存缓存相同契约且不共享可变字节', async () => {
  // get/put 和磁盘实现一样，以 Promise 报错。
  const cache = createMemoryRenderCache()
  const bytes = Uint8Array.of(1)
  await cache.put(key, bytes)
  bytes[0] = 2
  const result = (await cache.get(key))!
  result[0] = 3
  expect(await cache.get(key)).toEqual(Uint8Array.of(1))
  await cache.deleteHash(key.hash)
  await verify(cache)
})
test('只删除其他 v数字 目录，保留当前版本和无关目录/文件', async () => {
  const root = join(directory, 'versions'),
    cache = createLocalRenderCache(root)
  await cache.pruneOtherVersions()
  const old = `v${RENDERER_VERSION + 1}`
  for (const name of [old, `v${RENDERER_VERSION}`, 'unrelated']) await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, 'v9999'), 'unrelated file')
  await cache.put(key, Uint8Array.of(3))
  await cache.pruneOtherVersions()
  expect((await readdir(root)).sort()).toEqual(['unrelated', `v${RENDERER_VERSION}`, 'v9999'].sort())
  expect(await cache.get(key)).not.toBeNull()
})
test('缓存文件系统错误不暴露本地路径', async () => {
  await expect(createLocalRenderCache('\0').put(key, Uint8Array.of(1))).rejects.toThrow(/^访问出图缓存失败/)
})
