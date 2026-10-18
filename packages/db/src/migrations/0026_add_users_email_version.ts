import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('email_version', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()
}
