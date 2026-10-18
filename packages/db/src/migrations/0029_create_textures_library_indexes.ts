import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // type 放在排序列之后：skin 的 IN (steve, alex) 也能按索引顺序取前一页，不必合并排序。
  await db.schema
    .createIndex('textures_library_latest_index')
    .on('textures')
    .columns(['is_public', 'id', 'type'])
    .execute()
  await db.schema
    .createIndex('textures_library_popular_index')
    .on('textures')
    .columns(['is_public', 'likes', 'id', 'type'])
    .execute()
  await db.schema.createIndex('textures_uploader_latest_index').on('textures').columns(['uploader_id', 'id']).execute()
}
