import type { Kysely } from 'kysely'
import { alterToLongTextColumn } from '../helpers.ts'

/**
 * 审计记下页头代码、自定义 CSS 和 ads.txt 改前改后的全文（ADR-0063），一条最多两份五万字。
 * MySQL 的 text 最多 65 535 字节，严格模式下写不进去、整个事务失败
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await alterToLongTextColumn(db, 'audit_logs', 'details')
}
