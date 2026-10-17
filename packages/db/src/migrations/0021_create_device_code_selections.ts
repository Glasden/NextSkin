import type { Kysely } from 'kysely'
import { createTable, isoTimestampColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'device_code_selections')
    .addColumn('device_code', 'varchar(255)', (c) => c.notNull().primaryKey())
    .addColumn('user_id', 'integer', (c) => c.notNull())
    .addColumn('player_id', 'integer', (c) => c.notNull())
    .$call(isoTimestampColumn(db, 'created_at'))
    .addForeignKeyConstraint('device_code_selections_user_id_fk', ['user_id'], 'users', ['id'], (c) =>
      c.onDelete('cascade'),
    )
    .addForeignKeyConstraint('device_code_selections_player_id_fk', ['player_id'], 'players', ['id'], (c) =>
      c.onDelete('cascade'),
    )
    .execute()
  await db.schema
    .createIndex('device_code_selections_user_id_index')
    .on('device_code_selections')
    .column('user_id')
    .execute()
  await db.schema
    .createIndex('device_code_selections_player_id_index')
    .on('device_code_selections')
    .column('player_id')
    .execute()
}
