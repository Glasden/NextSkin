import { toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { isSiteInitialized } from './initialized.ts'

/** 注册测试保留空的用户表，用成功导入的记录表示已经完成安装。 */
export async function markSiteInitialized(db: Kysely<CoreDatabase>): Promise<void> {
  if (await isSiteInitialized(db)) return
  await db
    .insertInto('import_runs')
    .values({
      status: 'succeeded',
      is_dry_run: 0,
      entry: 'cli',
      source: '{}',
      started_at: toIsoTimestamp(new Date()),
    })
    .execute()
}
