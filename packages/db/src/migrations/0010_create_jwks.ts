import type { Kysely } from 'kysely'
import { authDateType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'jwks')
    .$call(autoIncrementId(db))
    .addColumn('public_key', 'text', (c) => c.notNull())
    .addColumn('private_key', 'text', (c) => c.notNull())
    .addColumn('created_at', authDateType(db), (c) => c.notNull())
    .addColumn('expires_at', authDateType(db))
    .addColumn('alg', 'text')
    .addColumn('crv', 'text')
    .execute()
}
