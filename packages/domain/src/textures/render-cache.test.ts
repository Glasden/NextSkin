import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTestDirectory } from '@nextskin/db/testing'
import { MAX_HEAD_DENSITY, MAX_POSE_DENSITY, RENDERER_VERSION } from '@nextskin/skin'
import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  createLocalRenderCache,
  createMemoryRenderCache,
  POSE_KINDS,
  renderKey,
  type RenderCache,
  type RenderKey,
} from './render-cache.ts'

let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nextskin-cache-'))
})
afterAll(async () => {
  await removeTestDirectory(directory)
})
const key: RenderKey = { hash: 'a'.repeat(64), kind: 'figure', model: 'alex', k: 1 }
async function verify(cache: RenderCache) {
  const bytes = Uint8Array.of(1, 2, 3),
    another = { ...key, hash: 'b'.repeat(64) }
  expect(await cache.get(key)).toBeNull()
  await Promise.all([cache.put(key, bytes), cache.put({ ...key, kind: 'head' }, bytes), cache.put(another, bytes)])
  for (const kind of POSE_KINDS) {
    const pose = { ...key, kind, k: 3 }
    expect(await cache.get(pose)).toBeNull()
    await cache.put(pose, Uint8Array.of(4))
    expect(new Uint8Array((await cache.get(pose))!)).toEqual(Uint8Array.of(4))
  }
  expect(new Uint8Array((await cache.get(key))!)).toEqual(bytes)
  await cache.deleteHash(key.hash)
  expect(await cache.get(key)).toBeNull()
  expect(await cache.get({ ...key, kind: 'head' })).toBeNull()
  for (const kind of POSE_KINDS) expect(await cache.get({ ...key, kind, k: 3 })).toBeNull()
  expect(new Uint8Array((await cache.get(another))!)).toEqual(bytes)
  await cache.deleteHash(key.hash)
  await cache.pruneOtherVersions()
  await expect(cache.get({ ...key, hash: '../outside' })).rejects.toThrow()
  await expect(cache.put({ ...key, model: '../outside' as 'alex' }, bytes)).rejects.toThrow()
}
test.each(POSE_KINDS)('%s 缓存键只允许皮肤模型和 1 到最大密度的整数', (kind) => {
  for (const model of ['steve', 'alex'] as const) {
    for (const k of [1, 3, MAX_POSE_DENSITY])
      expect(renderKey({ ...key, kind, model, k })).toBe(`${key.hash}/${kind}-${model}-${k}.png`)
  }
  for (const k of [0, -1, 1.5, MAX_POSE_DENSITY + 1, NaN, Infinity])
    expect(() => renderKey({ ...key, kind, k })).toThrow()
  expect(() => renderKey({ ...key, kind, model: 'cape' })).toThrow()
  expect(() => renderKey({ ...key, kind: 'unknown' as RenderKey['kind'] })).toThrow()
})
test('头像的缓存键是 1 到最大头像密度的整数', () => {
  for (const k of [1, 3, MAX_HEAD_DENSITY])
    expect(renderKey({ ...key, kind: 'head', model: 'steve', k })).toBe(`${key.hash}/head-steve-${k}.png`)
  for (const k of [0, -1, 1.5, MAX_HEAD_DENSITY + 1, NaN, Infinity])
    expect(() => renderKey({ ...key, kind: 'head', model: 'steve', k })).toThrow()
})
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
