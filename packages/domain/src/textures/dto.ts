import type { CoreDatabase, TexturesTable } from '@nextskin/db'
import type { Texture } from '@nextskin/plugin-sdk'
import type { Kysely, Selectable } from 'kysely'

export function textureRows(db: Kysely<CoreDatabase>) {
  return db
    .selectFrom('textures')
    .innerJoin('texture_files', 'texture_files.hash', 'textures.hash')
    .selectAll('textures')
    .select(['texture_files.width', 'texture_files.height', 'texture_files.size_bytes', 'texture_files.pixel_hash'])
}
export type TextureRow = Selectable<TexturesTable> & {
  width: number | null
  height: number | null
  size_bytes: number | null
  pixel_hash: string | null
}
export function toTexture(row: TextureRow): Texture {
  if (row.width === null || row.height === null || row.size_bytes === null) throw new Error('材质文件元数据缺失')
  return {
    tid: row.id,
    name: row.name,
    type: row.type,
    hash: row.hash,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    uploader: row.uploader_id,
    description: row.description,
    public: row.is_public === 1,
    likes: row.likes,
    uploadedAt: row.created_at,
  }
}
export const storageFee = (bytes: number, price: number): number => Math.ceil(bytes / 1024) * price
