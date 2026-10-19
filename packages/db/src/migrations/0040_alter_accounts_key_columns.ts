import type { Kysely } from 'kysely'
import { alterToAuthStringColumn } from '../helpers.ts'

/**
 * 第三方登录的绑定存在 accounts（ADR-0034）：`provider_id` 是 `plugin:<插件 id>:<Provider id>`，`account_id` 是第三方的 subject。
 * 两列要建唯一索引，先从 text 改成限长的字符串。两列都只有 ASCII：`credential` 行的 `account_id` 是 uid，
 * 插件 id、Provider id 和 subject 的格式由核心校验
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await alterToAuthStringColumn(db, 'accounts', 'account_id', 255, { ascii: true })
  await alterToAuthStringColumn(db, 'accounts', 'provider_id', 255, { ascii: true })
}
