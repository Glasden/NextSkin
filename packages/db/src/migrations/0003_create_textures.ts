import { sql, type Kysely } from 'kysely'
import { autoIncrementId, createTable, isoTimestampColumn, switchColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'textures')
    .$call(autoIncrementId(db))
    .addColumn('hash', 'varchar(64)', (c) => c.notNull())
    .addColumn('name', 'varchar(128)', (c) => c.notNull())
    .addColumn('type', 'varchar(8)', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('uploader_id', 'integer')
    .$call(switchColumn(db, 'is_public'))
    .addColumn('likes', 'integer', (c) => c.notNull().defaultTo(0))
    .$call(isoTimestampColumn(db, 'created_at'))
    .$call(isoTimestampColumn(db, 'updated_at'))
    .addCheckConstraint('textures_type_check', sql`type in ('steve', 'alex', 'cape')`)
    .addForeignKeyConstraint('textures_hash_fk', ['hash'], 'texture_files', ['hash'], (c) => c.onDelete('restrict'))
    .addForeignKeyConstraint('textures_uploader_id_fk', ['uploader_id'], 'users', ['id'], (c) => c.onDelete('set null'))
    .execute()
  await db.schema.createIndex('textures_hash_index').on('textures').column('hash').execute()
  await db.schema.createIndex('textures_uploader_id_index').on('textures').column('uploader_id').execute()
}
