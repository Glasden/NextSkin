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
  await createTable(db, 'oauth_clients')
    .$call(autoIncrementId(db))
    .addColumn('client_id', authStringType(db, 255), (c) => c.notNull())
    .addColumn('client_secret', 'text')
    .addColumn('client_discovery_id', 'text')
    .addColumn('disabled', authBooleanType(db))
    .addColumn('skip_consent', authBooleanType(db))
    .addColumn('enable_end_session', authBooleanType(db))
    .addColumn('subject_type', 'text')
    .addColumn('scopes', authJsonType(db))
    .addColumn('client_credentials_scopes', authJsonType(db))
    .addColumn('user_id', 'integer')
    .addColumn('created_at', authDateType(db))
    .addColumn('updated_at', authDateType(db))
    .addColumn('name', 'text')
    .addColumn('uri', 'text')
    .addColumn('icon', 'text')
    .addColumn('contacts', authJsonType(db))
    .addColumn('tos', 'text')
    .addColumn('policy', 'text')
    .addColumn('software_id', 'text')
    .addColumn('software_version', 'text')
    .addColumn('software_statement', 'text')
    .addColumn('redirect_uris', authJsonType(db), (c) => c.notNull())
    .addColumn('post_logout_redirect_uris', authJsonType(db))
    .addColumn('backchannel_logout_uri', 'text')
    .addColumn('backchannel_logout_session_required', authBooleanType(db))
    .addColumn('token_endpoint_auth_method', 'text')
    .addColumn('application_type', 'text')
    .addColumn('jwks', 'text')
    .addColumn('jwks_uri', 'text')
    .addColumn('grant_types', authJsonType(db))
    .addColumn('response_types', authJsonType(db))
    .addColumn('require_pkce', authBooleanType(db))
    .addColumn('dpop_bound_access_tokens', authBooleanType(db))
    .addColumn('reference_id', 'text')
    .addColumn('metadata', authJsonType(db))
    .addForeignKeyConstraint('oauth_clients_user_id_fk', ['user_id'], 'users', ['id'], (c) => c.onDelete('cascade'))
    .execute()
  await db.schema.createIndex('oauth_clients_client_id_uidx').on('oauth_clients').column('client_id').unique().execute()
  await db.schema.createIndex('oauth_clients_user_id_idx').on('oauth_clients').column('user_id').execute()
}
