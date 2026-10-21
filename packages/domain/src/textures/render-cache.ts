import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_POSE_DENSITY, RENDERER_VERSION, type TextureType } from '@nextskin/skin'
import { assertTextureHash } from './storage.ts'

export const POSE_KINDS = ['both', 'both-raise', 'front', 'front-raise'] as const
export type PoseKind = (typeof POSE_KINDS)[number]

export interface RenderKey {
  hash: string
  kind: 'figure' | 'head' | PoseKind
  model: TextureType
  k: number
}
/** 派生数据，随时可以丢弃、重建，不参与材质文件的认领和引用计数。 */
export interface RenderCache {
  get(key: RenderKey): Promise<Uint8Array | null>
  put(key: RenderKey, bytes: Uint8Array): Promise<void>
  deleteHash(hash: string): Promise<void>
  pruneOtherVersions(): Promise<void>
}
export function renderKey(key: RenderKey): string {
  assertTextureHash(key.hash)
  const pose = POSE_KINDS.some((kind) => kind === key.kind)
  if (
    !['figure', 'head', ...POSE_KINDS].includes(key.kind) ||
    !['steve', 'alex', 'cape'].includes(key.model) ||
    (pose && key.model === 'cape') ||
    !Number.isSafeInteger(key.k) ||
    key.k < 1 ||
    key.k > (pose ? MAX_POSE_DENSITY : 9999)
  ) {
    throw new Error('出图缓存键不合法')
  }
  return `${key.hash}/${key.kind}-${key.model}-${key.k}.png`
}
export function createMemoryRenderCache(): RenderCache {
  const entries = new Map<string, Uint8Array>()
  return {
    get: (key) => Promise.resolve().then(() => entries.get(renderKey(key))?.slice() ?? null),
    put: (key, bytes) =>
      Promise.resolve().then(() => {
        entries.set(renderKey(key), bytes.slice())
      }),
    deleteHash(hash) {
      assertTextureHash(hash)
      for (const key of entries.keys()) if (key.startsWith(`${hash}/`)) entries.delete(key)
      return Promise.resolve()
    },
    pruneOtherVersions: () => Promise.resolve(),
  }
}
export function createLocalRenderCache(directory: string): RenderCache {
  const version = `v${RENDERER_VERSION}`,
    root = join(directory, version)
  async function operation<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch {
      throw new Error('访问出图缓存失败；请检查缓存目录和进程权限')
    }
  }
  return {
    async get(key) {
      const path = join(root, renderKey(key))
      return operation(async () => {
        try {
          return await readFile(path)
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
          throw error
        }
      })
    },
    async put(key, bytes) {
      const path = join(root, renderKey(key)),
        temporary = `${path}.${randomUUID()}.tmp`
      await operation(async () => {
        await mkdir(join(root, key.hash), { recursive: true })
        try {
          await writeFile(temporary, bytes)
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
      })
    },
    async deleteHash(hash) {
      assertTextureHash(hash)
      await operation(() => rm(join(root, hash), { recursive: true, force: true }))
    },
    async pruneOtherVersions() {
      await operation(async () => {
        let entries
        try {
          entries = await readdir(directory, { withFileTypes: true })
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
          throw error
        }
        for (const entry of entries) {
          if (entry.isDirectory() && /^v\d+$/.test(entry.name) && entry.name !== version) {
            await rm(join(directory, entry.name), { recursive: true, force: true })
          }
        }
      })
    },
  }
}
