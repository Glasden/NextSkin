import type { Kysely } from 'kysely'
import { autoIncrementId, createTable, isoTimestampColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'players')
    .$call(autoIncrementId(db))
    .addColumn('user_id', 'integer', (c) => c.notNull())
    .addColumn('name', 'varchar(50)', (c) => c.notNull())
    .addColumn('name_key', 'varchar(100)', (c) => c.notNull())
    .addColumn('uuid', 'varchar(32)', (c) => c.notNull())
    .addColumn('skin_texture_id', 'integer')
    .addColumn('cape_texture_id', 'integer')
    .$call(isoTimestampColumn(db, 'created_at'))
    .$call(isoTimestampColumn(db, 'updated_at'))
    .addForeignKeyConstraint('players_user_id_fk', ['user_id'], 'users', ['id'], (c) => c.onDelete('cascade'))
    .addForeignKeyConstraint('players_skin_texture_id_fk', ['skin_texture_id'], 'textures', ['id'], (c) =>
      c.onDelete('set null'),
    )
    .addForeignKeyConstraint('players_cape_texture_id_fk', ['cape_texture_id'], 'textures', ['id'], (c) =>
      c.onDelete('set null'),
    )
    .execute()
  await db.schema.createIndex('players_user_id_index').on('players').column('user_id').execute()
  await db.schema.createIndex('players_skin_texture_id_index').on('players').column('skin_texture_id').execute()
  await db.schema.createIndex('players_cape_texture_id_index').on('players').column('cape_texture_id').execute()
  await db.schema.createIndex('players_name_key_unique').on('players').column('name_key').unique().execute()
  await db.schema.createIndex('players_uuid_unique').on('players').column('uuid').unique().execute()
}
