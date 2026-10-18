import type { CoreDatabase } from '@nextskin/db'
import { pickResolution, textureScale, TextureShapeError, type TextureType } from '@nextskin/skin'
import type { Kysely } from 'kysely'
import { DomainError } from '../errors.ts'
import type { ImagePool } from './image-pool.ts'
import { renderKey, type RenderCache, type RenderKey } from './render-cache.ts'
import type { TextureStorage } from './storage.ts'

export function createRenders({
  db,
  storage,
  cache,
  pool,
}: {
  db: Kysely<CoreDatabase>
  storage: Pick<TextureStorage, 'read'>
  cache: RenderCache
  pool: ImagePool
}) {
  const pending = new Map<string, Promise<Uint8Array | null>>()
  async function find(hash: string) {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null
    const row = await db
      .selectFrom('texture_files')
      .select(['hash', 'status', 'width', 'height'])
      .where('hash', '=', hash)
      .where('status', '=', 'active')
      .executeTakeFirst()
    return row?.hash === hash && row.status === 'active' ? row : null
  }
  // 出图缓存随时可以丢（ADR-0017）：读写失败就当没有缓存，照样出图
  async function generate(key: RenderKey): Promise<Uint8Array | null> {
    const cached = await cache.get(key).catch(() => null)
    if (cached) return cached
    const source = await storage.read(key.hash)
    if (!source) return null
    let bytes: Uint8Array
    try {
      // readFile 可能返回池化 Buffer；提供独占 ArrayBuffer 让池可以转移所有权。
      bytes = await pool.render({ kind: key.kind, bytes: new Uint8Array(source), type: key.model, k: key.k })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'service_unavailable') throw error
      return null
    }
    await cache.put(key, bytes).catch(() => console.warn('写入出图缓存失败'))
    return bytes
  }
  async function render(key: RenderKey): Promise<Uint8Array | null> {
    // 即使命中缓存或有正在生成的任务，每个请求仍先核对 active 行。
    const row = await find(key.hash)
    if (!row || row.width === null || row.height === null) return null
    let s: number
    try {
      s = textureScale(key.model, row.width, row.height)
    } catch (error) {
      if (error instanceof TextureShapeError) return null
      throw error
    }
    if (!Number.isSafeInteger(key.k) || key.k < 1 || s % key.k !== 0) return null
    const id = renderKey(key)
    const existing = pending.get(id)
    if (existing) return existing
    const promise = generate(key).finally(() => pending.delete(id))
    pending.set(id, promise)
    return promise
  }
  const figure = ({ hash, model, k }: { hash: string; model: TextureType; k: number }) =>
    render({ hash, model, k, kind: 'figure' })
  const head = ({ hash, k }: { hash: string; k: number }) => render({ hash, model: 'steve', k, kind: 'head' })
  return {
    figure,
    head,
    warm(hash: string, type: TextureType): void {
      void (async () => {
        const row = await find(hash)
        if (!row || row.width === null || row.height === null) return
        const s = textureScale(type, row.width, row.height)
        const figures = new Set<number>(),
          heads = new Set<number>()
        for (const dpr of [1, 2]) {
          for (const n of [3, 4, 5, 8]) figures.add(pickResolution(s, n, dpr))
          if (type !== 'cape') for (const n of [2, 3, 4, 6]) heads.add(pickResolution(s, n, dpr))
        }
        const results = await Promise.all([
          ...Array.from(figures, (k) => figure({ hash, model: type, k })),
          ...Array.from(heads, (k) => head({ hash, k })),
        ])
        if (results.some((bytes) => bytes === null)) throw new Error('出图预热失败')
      })().catch(() => console.warn('材质出图缓存预热失败'))
    },
    purge: (hash: string) => cache.deleteHash(hash),
  }
}
