import type { Kysely } from 'kysely'
import { createTable, isoTimestampColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'job_schedules')
    .addColumn('name', 'varchar(128)', (c) => c.primaryKey().notNull())
    .addColumn('cron', 'varchar(255)', (c) => c.notNull())
    .addColumn('time_zone', 'varchar(64)', (c) => c.notNull())
    .$call(isoTimestampColumn(db, 'next_run_at'))
    .execute()
}
