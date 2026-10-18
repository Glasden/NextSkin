import type { Kysely } from 'kysely'
import { createTable, isoTimestampColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'closet_items')
    .addColumn('user_id', 'integer', (c) => c.notNull())
    .addColumn('texture_id', 'integer', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('score_paid', 'integer', (c) => c.notNull().defaultTo(0))
    .$call(isoTimestampColumn(db, 'created_at'))
    .addPrimaryKeyConstraint('closet_items_pk', ['user_id', 'texture_id'])
    .addForeignKeyConstraint('closet_items_user_id_fk', ['user_id'], 'users', ['id'], (c) => c.onDelete('cascade'))
    .addForeignKeyConstraint('closet_items_texture_id_fk', ['texture_id'], 'textures', ['id'], (c) =>
      c.onDelete('cascade'),
    )
    .execute()
  await db.schema.createIndex('closet_items_texture_id_index').on('closet_items').column('texture_id').execute()
}
