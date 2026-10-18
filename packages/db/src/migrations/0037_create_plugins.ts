import type { Kysely } from 'kysely'
import { createTable, isoTimestampColumn, switchColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'plugins')
    .addColumn('id', 'varchar(64)', (c) => c.primaryKey().notNull())
    .addColumn('version', 'varchar(64)', (c) => c.notNull())
    .$call(switchColumn(db, 'is_enabled'))
    .addColumn('capabilities', 'text', (c) => c.notNull())
    .addColumn('package_hash', 'varchar(64)')
    .addColumn('last_error', 'varchar(500)')
    .$call(isoTimestampColumn(db, 'installed_at'))
    .$call(isoTimestampColumn(db, 'updated_at'))
    .execute()
}
