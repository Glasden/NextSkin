import { sql, type Kysely } from 'kysely'
import { autoIncrementId, createTable, isoTimestampColumn, longTextType, switchColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'import_runs')
    .$call(autoIncrementId(db))
    .addColumn('status', 'varchar(16)', (c) => c.notNull())
    .$call(switchColumn(db, 'is_dry_run'))
    .addColumn('entry', 'varchar(16)', (c) => c.notNull())
    .addColumn('started_by', 'varchar(255)')
    .addColumn('source', longTextType(db), (c) => c.notNull())
    .addColumn('report', longTextType(db))
    .$call(isoTimestampColumn(db, 'started_at'))
    .$call(isoTimestampColumn(db, 'finished_at', { nullable: true }))
    .addCheckConstraint(
      'import_runs_status_check',
      sql`status in ('running', 'succeeded', 'blocked', 'failed', 'cancelled')`,
    )
    .addCheckConstraint('import_runs_entry_check', sql`entry in ('setup', 'admin', 'cli')`)
    .execute()
}
