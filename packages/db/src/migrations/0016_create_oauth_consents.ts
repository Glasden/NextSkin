import type { Kysely } from 'kysely'
import { authDateType, authJsonType, authStringType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'oauth_consents')
    .$call(autoIncrementId(db))
    .addColumn('client_id', authStringType(db, 255), (c) => c.notNull())
    .addColumn('user_id', 'integer')
    .addColumn('reference_id', 'text')
    .addColumn('resources', authJsonType(db))
    .addColumn('requested_user_info_claims', authJsonType(db))
    .addColumn('scopes', authJsonType(db), (c) => c.notNull())
    .addColumn('created_at', authDateType(db), (c) => c.notNull())
    .addColumn('updated_at', authDateType(db), (c) => c.notNull())
    .addForeignKeyConstraint('oauth_consents_client_id_fk', ['client_id'], 'oauth_clients', ['client_id'], (c) =>
      c.onDelete('cascade'),
    )
    .addForeignKeyConstraint('oauth_consents_user_id_fk', ['user_id'], 'users', ['id'], (c) => c.onDelete('cascade'))
    .execute()
  await db.schema.createIndex('oauth_consents_client_id_idx').on('oauth_consents').column('client_id').execute()
  await db.schema.createIndex('oauth_consents_user_id_idx').on('oauth_consents').column('user_id').execute()
}
