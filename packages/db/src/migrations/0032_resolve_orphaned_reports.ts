import { sql, type Kysely } from 'kysely'
import { toIsoTimestamp } from '../helpers.ts'

/**
 * ADR-0027 要求待处理的举报总是指向存在的材质：之后材质删除时会一并结案它的待处理举报。
 * 迁移 0030 建表之后、这条规则落地之前，上传者删除材质会留下 `texture_id` 为空的待处理举报，管理员处理不了它们。
 * 这里按“上传者自己删除”的结果结案：处理人为空。花费不退：这段代码没有发布过，这类记录只在开发库里，
 * 而积分只能经过 adjustScore 修改（ADR-0021），迁移不碰积分
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = toIsoTimestamp(new Date())
  await sql`
    update reports set status = 'resolved', resolution = 'textureDeleted', resolved_at = ${now}
    where status = 'pending' and texture_id is null
  `.execute(db)
}
