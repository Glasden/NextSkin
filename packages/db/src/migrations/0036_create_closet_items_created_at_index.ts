import type { Kysely } from 'kysely'
import { dialectOf } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createIndex('closet_items_created_at_index').on('closet_items').column('created_at').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const query = db.schema.dropIndex('closet_items_created_at_index')
  await (dialectOf(db) === 'mysql' ? query.on('closet_items') : query).execute()
}
