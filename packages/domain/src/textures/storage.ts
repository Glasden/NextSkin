import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface TextureStorage {
  read(hash: string): Promise<Uint8Array | null>
  write(hash: string, claimId: string, bytes: Uint8Array): Promise<void>
  delete(hash: string): Promise<void>
  deleteTemp(hash: string, claimId: string): Promise<void>
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
  return {
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
