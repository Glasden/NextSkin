import type { CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'

/** 成功的试跑没有写入站点，不能算完成安装。 */
export async function isSiteInitialized(db: Kysely<CoreDatabase>): Promise<boolean> {
  if (await db.selectFrom('users').select('id').limit(1).executeTakeFirst()) return true
  return !!(await db
    .selectFrom('import_runs')
    .select('id')
    .where('status', '=', 'succeeded')
    .where('is_dry_run', '=', 0)
    .limit(1)
    .executeTakeFirst())
}
