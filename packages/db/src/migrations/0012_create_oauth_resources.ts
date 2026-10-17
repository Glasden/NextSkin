import type { Kysely } from 'kysely'
import {
  authBooleanType,
  authDateType,
  authJsonType,
  authStringType,
  autoIncrementId,
  createTable,
} from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'oauth_resources')
    .$call(autoIncrementId(db))
    .addColumn('identifier', authStringType(db, 255), (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('access_token_ttl', 'integer')
    .addColumn('refresh_token_ttl', 'integer')
    .addColumn('signing_algorithm', 'text')
    .addColumn('signing_key_id', 'text')
    .addColumn('allowed_scopes', authJsonType(db))
    .addColumn('custom_claims', authJsonType(db))
    .addColumn('dpop_bound_access_tokens_required', authBooleanType(db))
    .addColumn('disabled', authBooleanType(db))
    .addColumn('created_at', authDateType(db))
    .addColumn('updated_at', authDateType(db))
    .addColumn('policy_version', 'integer')
    .addColumn('metadata', authJsonType(db))
    .execute()
  await db.schema
    .createIndex('oauth_resources_identifier_uidx')
    .on('oauth_resources')
    .column('identifier')
    .unique()
    .execute()
}
