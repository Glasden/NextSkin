import { sql, type Kysely } from 'kysely'
import { autoIncrementId, createTable, isoTimestampColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'audit_logs')
    .$call(autoIncrementId(db))
    .addColumn('actor_type', 'varchar(16)', (c) => c.notNull())
    .addColumn('actor_user_id', 'integer')
    .addColumn('actor_plugin_id', 'varchar(64)')
    .addColumn('action', 'varchar(64)', (c) => c.notNull())
    .addColumn('subject_type', 'varchar(32)', (c) => c.notNull())
    .addColumn('subject_id', 'integer', (c) => c.notNull())
    .addColumn('details', 'text', (c) => c.notNull())
    .addColumn('ip', 'varchar(45)')
    .$call(isoTimestampColumn(db, 'created_at'))
    .addCheckConstraint('audit_logs_actor_type_check', sql`actor_type in ('user', 'system', 'plugin')`)
    .execute()
  await db.schema
    .createIndex('audit_logs_subject_type_subject_id_id_index')
    .on('audit_logs')
    .columns(['subject_type', 'subject_id', 'id'])
    .execute()
  await db.schema
    .createIndex('audit_logs_actor_user_id_id_index')
    .on('audit_logs')
    .columns(['actor_user_id', 'id'])
    .execute()
}
