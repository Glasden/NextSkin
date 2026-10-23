import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('users').addColumn('theme', 'varchar(128)').execute()
}
