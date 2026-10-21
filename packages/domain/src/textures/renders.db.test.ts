import { readFile } from 'node:fs/promises'
import { coreMigrations, migrateToLatest, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { MAX_POSE_DENSITY } from '@nextskin/skin'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { DomainError } from '../errors.ts'
import { createImagePool, type ImagePool } from './image-pool.ts'
import { renderTexture } from './image.ts'
import { createMemoryRenderCache, POSE_KINDS } from './render-cache.ts'
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

test.each(POSE_KINDS)('%s 密度不必整除材质倍数，同键并发合并、缓存按模型和密度区分', async (kind) => {
  const request = { hash, kind, model: 'alex' as const, p: 3 },
    poseKey = { hash, kind, model: 'alex' as const, k: 3 }
  const outputs = await Promise.all(Array.from({ length: 10 }, () => service.pose(request)))
  expect(outputs[0]).toEqual(renderTexture({ kind, bytes, type: 'alex', k: 3 }))
  for (const output of outputs) expect(output).toEqual(outputs[0])
  expect(render).toHaveBeenCalledExactlyOnceWith({ kind, bytes, type: 'alex', k: 3 })
  expect(read).toHaveBeenCalledTimes(1)
  expect(await cache.get(poseKey)).toEqual(outputs[0])
  await service.pose(request)
  expect(render).toHaveBeenCalledTimes(1)
  render.mockResolvedValue(Uint8Array.of(9))
  await service.pose({ ...request, model: 'steve' })
  await service.pose({ ...request, p: MAX_POSE_DENSITY })
  expect(render).toHaveBeenCalledTimes(3)
  await service.purge(hash)
  expect(await cache.get(poseKey)).toBeNull()
  await service.pose(request)
  expect(render).toHaveBeenCalledTimes(4)
})

test.each(POSE_KINDS)('%s 拒绝非法参数和形状，命中缓存仍先检查 active 行', async (kind) => {
  const request = { hash, kind, model: 'alex' as const, p: 3 }
  for (const p of [0, -1, 1.5, MAX_POSE_DENSITY + 1, NaN, Infinity])
    expect(await service.pose({ ...request, p })).toBeNull()
  expect(await service.pose({ ...request, model: 'cape' })).toBeNull()
  expect(await service.pose({ ...request, kind: 'unknown' as typeof kind })).toBeNull()
  for (const hash of ['../outside', 'A'.repeat(64), 'b'.repeat(64), 'a'.repeat(64) + ' '])
    expect(await service.pose({ ...request, hash })).toBeNull()
  const poseKey = { hash, kind, model: 'alex' as const, k: 3 }
  await cache.put(poseKey, Uint8Array.of(9))
  expect(await service.pose(request)).toEqual(Uint8Array.of(9))
  await database.db.updateTable('texture_files').set({ width: 63 }).where('hash', '=', hash).execute()
  expect(await service.pose(request)).toBeNull()
  await database.db.updateTable('texture_files').set({ width: 64, height: 64 }).where('hash', '=', hash).execute()
  for (const status of ['pending', 'deleting'] as const) {
    await database.db.updateTable('texture_files').set({ status }).where('hash', '=', hash).execute()
    expect(await service.pose(request)).toBeNull()
  }
  await database.db.deleteFrom('texture_files').execute()
  expect(await service.pose(request)).toBeNull()
  expect(read).not.toHaveBeenCalled()
  expect(render).not.toHaveBeenCalled()
})

test.each(['figure', 'both'] as const)(
  '%s 读不到源文件、解码失败均为 null；池满传播 503；失败不占住合并键',
  async (kind) => {
    const run = () => (kind === 'figure' ? service.figure(input) : service.pose({ hash, kind, model: 'alex', p: 3 }))
    read.mockResolvedValue(null)
    expect(await run()).toBeNull()
    read.mockResolvedValue(bytes)
    render.mockRejectedValueOnce(new Error('decode failed'))
    expect(await run()).toBeNull()
    render.mockRejectedValueOnce(new DomainError('service_unavailable'))
    await expect(run()).rejects.toMatchObject({ code: 'service_unavailable' })
    expect(await run()).not.toBeNull()
  },
)

test.each(['figure', 'both'] as const)('%s 缓存读写失败仍可出图，且释放并发合并键', async (kind) => {
  const get = vi.spyOn(cache, 'get').mockRejectedValue(new Error('read failed')),
    put = vi.spyOn(cache, 'put').mockRejectedValue(new Error('write failed')),
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const run = () => (kind === 'figure' ? service.figure(input) : service.pose({ hash, kind, model: 'alex', p: 3 }))
  try {
    const first = await run()
    expect(first).not.toBeNull()
    expect(await run()).toEqual(first)
    expect(render).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith('写入出图缓存失败')
  } finally {
    get.mockRestore()
    put.mockRestore()
    warn.mockRestore()
  }
})

test('真 worker + 数据库 + 缓存完整出图路径', async () => {
  const pool = createImagePool({ size: 1 })
  try {
    const real = createRenders({ db: database.db, storage: { read }, cache, pool })
    const image = await real.figure(input)
    expect(image).toEqual(renderTexture({ kind: 'figure', bytes, type: 'alex', k: 1 }))
    expect(await real.figure(input)).toEqual(image)
    const pose = { hash, kind: 'both-raise' as const, model: 'alex' as const, p: 3 },
      raised = await real.pose(pose)
    expect(raised).toEqual(renderTexture({ kind: pose.kind, bytes, type: pose.model, k: pose.p }))
    expect(await real.pose(pose)).toEqual(raised)
  } finally {
    await pool.close()
  }
})

test('warm 皮肤生成头像和常用 3D 出图，披风按显示倍数和 DPR 去重，失败只记一行日志', async () => {
  render.mockResolvedValue(Uint8Array.of(9))
  await database.db.updateTable('texture_files').set({ width: 512, height: 512 }).where('hash', '=', hash).execute()
  service.warm(hash, 'alex')
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(10))
  const figures = render.mock.calls
    .filter(([i]) => i.kind === 'figure')
    .map(([i]) => i.k)
    .sort()
  const heads = render.mock.calls
    .filter(([i]) => i.kind === 'head')
    .map(([i]) => i.k)
    .sort()
  expect(figures).toEqual([])
  expect(heads).toEqual([1, 2, 4, 8])
  expect(
    render.mock.calls
      .filter(([i]) => i.kind === 'both')
      .map(([i]) => i.k)
      .sort(),
  ).toEqual([3, 4, 6, 8])
  expect(
    render.mock.calls
      .filter(([i]) => i.kind === 'both-raise')
      .map(([i]) => i.k)
      .sort(),
  ).toEqual([4, 8])
  expect(render.mock.calls.filter(([i]) => i.kind !== 'head').every(([i]) => i.type === 'alex')).toBe(true)
  await service.purge(hash)
  render.mockClear()
  await database.db.updateTable('texture_files').set({ height: 256 }).where('hash', '=', hash).execute()
  service.warm(hash, 'cape')
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(4))
  expect(render.mock.calls.every(([i]) => i.kind === 'figure')).toBe(true)
  expect(render.mock.calls.map(([i]) => i.k).sort()).toEqual([1, 2, 4, 8])
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
