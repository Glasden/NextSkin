import type { Kysely } from 'kysely'
import { autoIncrementId, createTable, isoTimestampColumn, longTextType } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'jobs')
    .$call(autoIncrementId(db))
    .addColumn('name', 'varchar(128)', (c) => c.notNull())
    .addColumn('payload', longTextType(db), (c) => c.notNull())
    .addColumn('dedupe_key', 'varchar(255)')
    .$call(isoTimestampColumn(db, 'run_at'))
    .addColumn('lease_id', 'varchar(36)')
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('last_error', 'varchar(500)')
    .$call(isoTimestampColumn(db, 'created_at'))
    .execute()
  await db.schema
    .createIndex('jobs_name_dedupe_key_unique')
    .on('jobs')
    .columns(['name', 'dedupe_key'])
    .unique()
    .execute()
  await db.schema.createIndex('jobs_run_at_id_index').on('jobs').columns(['run_at', 'id']).execute()
}
