import type { Kysely } from 'kysely'
import { createTable, isoTimestampColumn, longTextType } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'plugin_kv')
    .addColumn('plugin_id', 'varchar(64)', (c) => c.notNull())
    .addColumn('key', 'varchar(255)', (c) => c.notNull())
    .addColumn('value', longTextType(db), (c) => c.notNull())
    .$call(isoTimestampColumn(db, 'expires_at', { nullable: true }))
    .$call(isoTimestampColumn(db, 'updated_at'))
    .addPrimaryKeyConstraint('plugin_kv_pk', ['plugin_id', 'key'])
    .addForeignKeyConstraint('plugin_kv_plugin_id_fk', ['plugin_id'], 'plugins', ['id'], (c) => c.onDelete('cascade'))
    .execute()
  await db.schema.createIndex('plugin_kv_expires_at_index').on('plugin_kv').column('expires_at').execute()
}
