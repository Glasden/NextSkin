import type { Kysely } from 'kysely'
import { createTable, isoTimestampColumn, longTextType } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'settings')
    .addColumn('namespace', 'varchar(64)', (c) => c.notNull())
    .addColumn('key', 'varchar(128)', (c) => c.notNull())
    .addColumn('value', longTextType(db), (c) => c.notNull())
    .$call(isoTimestampColumn(db, 'updated_at'))
    .addPrimaryKeyConstraint('settings_pkey', ['namespace', 'key'])
    .execute()
}
