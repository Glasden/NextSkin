import type { Kysely } from 'kysely'
import { authDateType, authStringType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'verifications')
    .$call(autoIncrementId(db))
    .addColumn('identifier', authStringType(db, 255), (c) => c.notNull())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('expires_at', authDateType(db), (c) => c.notNull())
    .addColumn('created_at', authDateType(db), (c) => c.notNull())
    .addColumn('updated_at', authDateType(db), (c) => c.notNull())
    .execute()
  await db.schema.createIndex('verifications_identifier_idx').on('verifications').column('identifier').execute()
}
