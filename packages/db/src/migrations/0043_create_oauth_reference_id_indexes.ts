import type { Kysely } from 'kysely'
import { alterToAuthStringColumn } from '../helpers.ts'

/**
 * 角色转让、删除时按 `reference_id = player:<pid>` 删掉绑定它的 OAuth 令牌和同意记录（ADR-0037）。
 * 三列都是可空的 text，先改成限长的字符串才能在 MySQL 上建索引；值由核心写入，只有 ASCII
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_consents']) {
    await alterToAuthStringColumn(db, table, 'reference_id', 255, { ascii: true, nullable: true })
    await db.schema.createIndex(`${table}_reference_id_idx`).on(table).column('reference_id').execute()
  }
}
