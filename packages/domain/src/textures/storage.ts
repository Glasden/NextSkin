import { mkdir, readdir, readFile, rename, rm, lstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface TextureStorage {
  read(hash: string): Promise<Uint8Array | null>
  write(hash: string, claimId: string, bytes: Uint8Array): Promise<void>
  delete(hash: string): Promise<void>
  deleteTemp(hash: string, claimId: string): Promise<void>
  list(options: { after: string | null; limit: number }): Promise<{ key: string; modifiedAt: Date }[]>
  listTemp(): Promise<{ hash: string; claimId: string; modifiedAt: Date }[]>
  readonly lateDeleteWindowMs: number
}

export function assertTextureHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('材质 hash 必须是 64 位小写十六进制')
}
function assertClaimId(claimId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claimId))
    throw new Error('材质认领标识必须是 UUID')
}

/** 与 BS 的 storage/textures 布局相同；不重新编码文件。 */
export function createLocalTextureStorage(directory: string): TextureStorage {
  function temp(hash: string, claimId: string) {
    assertTextureHash(hash)
    assertClaimId(claimId)
    return join(directory, '.tmp', `${hash}.${claimId}`)
  }
  async function operation(action: () => Promise<unknown>) {
    try {
      await action()
    } catch {
      throw new Error('写入或删除材质文件失败；请检查材质存储目录和进程权限')
    }
  }
  async function entries(path: string) {
    try {
      return await readdir(path, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      // eslint-disable-next-line preserve-caught-error -- 不保留含本地存储路径的底层异常。
      throw new Error('列出材质文件失败；请检查材质存储目录和进程权限')
    }
  }
  return {
    async list({ after, limit }) {
      const page = (await entries(directory))
        .filter(
          (entry) => entry.isFile() && /^[0-9a-f]{64}$/.test(entry.name) && (after === null || entry.name > after),
        )
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .slice(0, limit)
      const result: { key: string; modifiedAt: Date }[] = []
      await operation(async () => {
        for (const entry of page) {
          // 页内文件被并发删除时让任务重试，不能把缩短的页误当成存储末尾。
          const info = await lstat(join(directory, entry.name))
          if (!info.isFile()) throw new Error('材质对象类型发生变化')
          result.push({ key: entry.name, modifiedAt: info.mtime })
        }
      })
      return result
    },
    async listTemp() {
      const result: { hash: string; claimId: string; modifiedAt: Date }[] = []
      const path = join(directory, '.tmp')
      const files = await entries(path)
      await operation(async () => {
        for (const entry of files) {
          if (!entry.isFile()) continue
          const match = /^([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
            entry.name,
          )
          if (!match || !/^[0-9a-f]{64}$/.test(match[1]!)) continue
          try {
            const info = await lstat(join(path, entry.name))
            if (info.isFile()) result.push({ hash: match[1]!, claimId: match[2]!, modifiedAt: info.mtime })
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          }
        }
      })
      return result
    },
    lateDeleteWindowMs: 0,
    async read(hash) {
      assertTextureHash(hash)
      try {
        return await readFile(join(directory, hash))
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        // eslint-disable-next-line preserve-caught-error -- 不保留含本地存储路径的底层异常。
        throw new Error('读取材质文件失败；请检查材质存储目录是否存在、进程是否有读权限')
      }
    },
    async write(hash, claimId, bytes) {
      const path = temp(hash, claimId)
      await operation(async () => {
        await mkdir(join(directory, '.tmp'), { recursive: true })
        await writeFile(path, bytes)
        // 临时文件被清理时 rename 必须失败，不能重新创建或忽略 ENOENT。
        await rename(path, join(directory, hash))
      })
    },
    async delete(hash) {
      assertTextureHash(hash)
      await operation(() => rm(join(directory, hash), { force: true }))
    },
    async deleteTemp(hash, claimId) {
      const path = temp(hash, claimId)
      await operation(() => rm(path, { force: true }))
    },
  }
}
