import type { CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import type { TextureStorage } from './storage.ts'

export function createTextureQueries(db: Kysely<CoreDatabase>, storage: TextureStorage) {
  async function findFile(hash: string) {
    const row = await db
      .selectFrom('texture_files')
      .select(['hash', 'size_bytes as sizeBytes', 'created_at as createdAt'])
      .where('hash', '=', hash)
      .where('status', '=', 'active')
      .executeTakeFirst()
    // MySQL 的 PAD SPACE 比较会接受尾随空格；文件键必须逐字相同。
    return row?.hash === hash ? row : null
  }
  return {
    findFile,
    async readFile(hash: string) {
      const file = await findFile(hash)
      if (!file) return null
      const bytes = await storage.read(hash)
      return bytes === null ? null : { ...file, bytes }
    },
  }
}
