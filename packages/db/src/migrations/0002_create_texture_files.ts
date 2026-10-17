import { sql, type Kysely } from 'kysely'
import { createTable, isoTimestampColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'texture_files')
    .addColumn('hash', 'varchar(64)', (c) => c.notNull().primaryKey())
    .addColumn('pixel_hash', 'varchar(64)')
    .addColumn('width', 'integer')
    .addColumn('height', 'integer')
    .addColumn('size_bytes', 'integer')
    .addColumn('ref_count', 'integer', (c) => c.notNull())
    .addColumn('status', 'varchar(16)', (c) => c.notNull())
    .addColumn('claim_id', 'varchar(36)')
    .$call(isoTimestampColumn(db, 'status_changed_at'))
    .$call(isoTimestampColumn(db, 'delete_attempted_at', { nullable: true }))
    .$call(isoTimestampColumn(db, 'delete_confirmed_at', { nullable: true }))
    .$call(isoTimestampColumn(db, 'created_at'))
    .addCheckConstraint('texture_files_status_check', sql`status in ('pending', 'active', 'deleting')`)
    .addCheckConstraint('texture_files_ref_count_check', sql`ref_count >= 0`)
    .addCheckConstraint(
      'texture_files_active_metadata_check',
      sql`status <> 'active' or (pixel_hash is not null and width is not null and height is not null and size_bytes is not null)`,
    )
    .execute()
  await db.schema.createIndex('texture_files_pixel_hash_index').on('texture_files').column('pixel_hash').execute()
}
