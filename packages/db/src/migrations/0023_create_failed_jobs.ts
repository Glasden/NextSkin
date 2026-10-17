import type { Kysely } from 'kysely'
import { autoIncrementId, createTable, isoTimestampColumn, longTextType } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'failed_jobs')
    .$call(autoIncrementId(db))
    .addColumn('name', 'varchar(128)', (c) => c.notNull())
    .addColumn('payload', longTextType(db), (c) => c.notNull())
    .addColumn('dedupe_key', 'varchar(255)')
    .addColumn('attempts', 'integer', (c) => c.notNull())
    .addColumn('last_error', 'varchar(500)')
    .$call(isoTimestampColumn(db, 'created_at'))
    .$call(isoTimestampColumn(db, 'failed_at'))
    .execute()
  await db.schema.createIndex('failed_jobs_failed_at_index').on('failed_jobs').column('failed_at').execute()
}
