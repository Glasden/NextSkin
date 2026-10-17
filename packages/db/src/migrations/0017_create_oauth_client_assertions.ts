import type { Kysely } from 'kysely'
import { authDateType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'oauth_client_assertions')
    .$call(autoIncrementId(db))
    .addColumn('expires_at', authDateType(db), (c) => c.notNull())
    .execute()
}
