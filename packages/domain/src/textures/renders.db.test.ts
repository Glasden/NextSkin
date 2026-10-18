import { readFile } from 'node:fs/promises'
import { coreMigrations, migrateToLatest, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { DomainError } from '../errors.ts'
import { createImagePool, type ImagePool } from './image-pool.ts'
import { renderTexture } from './image.ts'
import { createMemoryRenderCache } from './render-cache.ts'
import { createRenders } from './renders.ts'

let database: TestDatabase<CoreDatabase>, bytes: Uint8Array
const hash = 'a'.repeat(64),
  timestamp = toIsoTimestamp(new Date())
const file = (id = hash) => ({
  hash: id,
  pixel_hash: id,
  width: 64,
  height: 64,
  size_bytes: 100,
  ref_count: 1,
  status: 'active' as const,
  status_changed_at: timestamp,
  created_at: timestamp,
})
const key = { hash, kind: 'figure' as const, model: 'alex' as const, k: 1 }
const input = { hash, model: 'alex' as const, k: 1 }
let cache = createMemoryRenderCache(),
  read = vi.fn<(hash: string) => Promise<Uint8Array | null>>(),
  render = vi.fn<ImagePool['render']>()
let service: ReturnType<typeof createRenders>
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
  bytes = new Uint8Array(await readFile(new URL('../../../skin/test/fixtures/haka.png', import.meta.url)))
})
afterAll(async () => {
  await database?.cleanup()
})
beforeEach(async () => {
  await database.db.deleteFrom('texture_files').execute()
  await database.db.insertInto('texture_files').values(file()).execute()
  cache = createMemoryRenderCache()
  read = vi.fn<(hash: string) => Promise<Uint8Array | null>>().mockResolvedValue(bytes)
  render = vi
    .fn<ImagePool['render']>()
    .mockImplementation((input: Parameters<ImagePool['render']>[0]) => Promise.resolve(renderTexture(input)))
  service = createRenders({ db: database.db, storage: { read }, cache, pool: { render } as unknown as ImagePool })
})

test('非法 hash、无行、形状不合法、非约数 k 返回 null，不读源文件', async () => {
  for (const hash of ['../outside', 'A'.repeat(64), 'b'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + ' '])
    expect(await service.figure({ ...input, hash })).toBeNull()
  for (const k of [0, -1, 1.5, 2, NaN]) expect(await service.figure({ ...input, k })).toBeNull()
  expect(await service.figure({ ...input, model: 'cape' })).toBeNull()
  await database.db.updateTable('texture_files').set({ width: 63 }).where('hash', '=', hash).execute()
  expect(await service.figure(input)).toBeNull()
  expect(read).not.toHaveBeenCalled()
  expect(render).not.toHaveBeenCalled()
})

test('缓存命中仍先查 active 行；pending/deleting/无行即使缓存有图也返回 null', async () => {
  await cache.put(key, Uint8Array.of(9))
  expect(await service.figure(input)).toEqual(Uint8Array.of(9))
  expect(read).not.toHaveBeenCalled()
  expect(render).not.toHaveBeenCalled()
  for (const status of ['pending', 'deleting'] as const) {
    await database.db.updateTable('texture_files').set({ status }).where('hash', '=', hash).execute()
    expect(await service.figure(input)).toBeNull()
  }
  await database.db.deleteFrom('texture_files').execute()
  expect(await service.figure(input)).toBeNull()
})

test('MySQL PAD SPACE 的 hash 查找结果必须逐字相同', async () => {
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: () => Promise.resolve({ hash: hash + ' ', status: 'active', width: 64, height: 64 }),
  }
  const db = { selectFrom: () => query } as unknown as typeof database.db
  const padded = createRenders({ db, storage: { read }, cache, pool: { render } as unknown as ImagePool })
  expect(await padded.figure(input)).toBeNull()
  expect(read).not.toHaveBeenCalled()
})

test('生成写缓存、同 key 并发合并，头像固定 steve；purge 后重新生成', async () => {
  // 网络数据库上，后到的请求查完文件行时前一个可能已经生成完、改走缓存：只要求内容相同、只生成一次
  const outputs = await Promise.all(Array.from({ length: 10 }, () => service.figure(input)))
  for (const output of outputs) expect(output).toEqual(outputs[0])
  expect(render).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledTimes(1)
  expect(await cache.get(key)).toEqual(outputs[0])
  await service.figure(input)
  expect(render).toHaveBeenCalledTimes(1)
  await service.head({ hash, k: 1 })
  expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'head', type: 'steve', k: 1 }))
  await service.purge(hash)
  expect(await cache.get(key)).toBeNull()
  await service.figure(input)
  expect(render).toHaveBeenCalledTimes(3)
})

test('读不到源文件、解码失败均为 null；池满传播 503；失败不占住合并键', async () => {
  read.mockResolvedValue(null)
  expect(await service.figure(input)).toBeNull()
  read.mockResolvedValue(bytes)
  render.mockRejectedValueOnce(new Error('decode failed'))
  expect(await service.figure(input)).toBeNull()
  render.mockRejectedValueOnce(new DomainError('service_unavailable'))
  await expect(service.figure(input)).rejects.toMatchObject({ code: 'service_unavailable' })
  expect(await service.figure(input)).not.toBeNull()
})

test('真 worker + 数据库 + 缓存完整出图路径', async () => {
  const pool = createImagePool({ size: 1 })
  try {
    const real = createRenders({ db: database.db, storage: { read }, cache, pool })
    const image = await real.figure(input)
    expect(image).toEqual(renderTexture({ kind: 'figure', bytes, type: 'alex', k: 1 }))
    expect(await real.figure(input)).toEqual(image)
  } finally {
    await pool.close()
  }
})

test('warm 按显示倍数和 DPR 去重，披风不生成头像，失败只记一行日志', async () => {
  render.mockResolvedValue(Uint8Array.of(9))
  await database.db.updateTable('texture_files').set({ width: 512, height: 512 }).where('hash', '=', hash).execute()
  service.warm(hash, 'alex')
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(8))
  const figures = render.mock.calls
    .filter(([i]) => i.kind === 'figure')
    .map(([i]) => i.k)
    .sort()
  const heads = render.mock.calls
    .filter(([i]) => i.kind === 'head')
    .map(([i]) => i.k)
    .sort()
  expect(figures).toEqual([1, 2, 4, 8])
  expect(heads).toEqual([1, 2, 4, 8])
  await service.purge(hash)
  render.mockClear()
  await database.db.updateTable('texture_files').set({ height: 256 }).where('hash', '=', hash).execute()
  service.warm(hash, 'cape')
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(4))
  expect(render.mock.calls.every(([i]) => i.kind === 'figure')).toBe(true)
  await service.purge(hash)
  render.mockRejectedValue(new Error('sensitive detail'))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    service.warm(hash, 'cape')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledExactlyOnceWith('材质出图缓存预热失败'))
  } finally {
    warn.mockRestore()
  }
})
