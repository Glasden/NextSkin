import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('players')
    .addColumn('score_paid', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()
}
