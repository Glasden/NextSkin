import type { Kysely } from 'kysely'
import { createTable, isoTimestampColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'plugin_migrations')
    .addColumn('plugin_id', 'varchar(64)', (c) => c.notNull())
    .addColumn('name', 'varchar(128)', (c) => c.notNull())
    .$call(isoTimestampColumn(db, 'executed_at'))
    .addPrimaryKeyConstraint('plugin_migrations_pk', ['plugin_id', 'name'])
    .addForeignKeyConstraint('plugin_migrations_plugin_id_fk', ['plugin_id'], 'plugins', ['id'], (c) =>
      c.onDelete('cascade'),
    )
    .execute()
}
