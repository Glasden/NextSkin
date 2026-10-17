import type { Kysely } from 'kysely'
import { addForeignKeyColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await addForeignKeyColumn(db, {
    table: 'users',
    column: 'avatar_texture_id',
    references: { table: 'textures', column: 'id' },
    onDelete: 'set null',
    constraintName: 'users_avatar_texture_id_fk',
  })
  await db.schema.createIndex('users_avatar_texture_id_index').on('users').column('avatar_texture_id').execute()
}
