import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface TextureStorage {
  /** 返回原始文件字节；不存在时返回 null。 */
  read(hash: string): Promise<Uint8Array | null>
}

/** 与 BS 的 storage/textures 布局相同；不重新编码文件。 */
export function createLocalTextureStorage(directory: string): TextureStorage {
  return {
    async read(hash) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null
      try {
        return await readFile(join(directory, hash))
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        // eslint-disable-next-line preserve-caught-error -- 不保留含本地存储路径的底层异常。
        throw new Error('读取材质文件失败；请检查材质存储目录是否存在、进程是否有读权限')
      }
    },
  }
}
