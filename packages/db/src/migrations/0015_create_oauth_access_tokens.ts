import type { Kysely } from 'kysely'
import { authDateType, authJsonType, authStringType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'oauth_access_tokens')
    .$call(autoIncrementId(db))
    .addColumn('token', authStringType(db, 255), (c) => c.notNull())
    .addColumn('client_id', authStringType(db, 255), (c) => c.notNull())
    .addColumn('session_id', 'integer')
    .addColumn('user_id', 'integer')
    .addColumn('reference_id', 'text')
    .addColumn('authorization_code_id', authStringType(db, 255))
    .addColumn('resources', authJsonType(db))
    .addColumn('requested_user_info_claims', authJsonType(db))
    .addColumn('refresh_id', 'integer')
    .addColumn('expires_at', authDateType(db), (c) => c.notNull())
    .addColumn('created_at', authDateType(db), (c) => c.notNull())
    .addColumn('revoked', authDateType(db))
    .addColumn('confirmation', authJsonType(db))
    .addColumn('scopes', authJsonType(db), (c) => c.notNull())
    .addForeignKeyConstraint('oauth_access_tokens_client_id_fk', ['client_id'], 'oauth_clients', ['client_id'], (c) =>
      c.onDelete('cascade'),
    )
    .addForeignKeyConstraint('oauth_access_tokens_session_id_fk', ['session_id'], 'sessions', ['id'], (c) =>
      c.onDelete('set null'),
    )
    .addForeignKeyConstraint('oauth_access_tokens_user_id_fk', ['user_id'], 'users', ['id'], (c) =>
      c.onDelete('cascade'),
    )
    .addForeignKeyConstraint('oauth_access_tokens_refresh_id_fk', ['refresh_id'], 'oauth_refresh_tokens', ['id'], (c) =>
      c.onDelete('cascade'),
    )
    .execute()
  await db.schema
    .createIndex('oauth_access_tokens_token_uidx')
    .on('oauth_access_tokens')
    .column('token')
    .unique()
    .execute()
  await db.schema
    .createIndex('oauth_access_tokens_client_id_idx')
    .on('oauth_access_tokens')
    .column('client_id')
    .execute()
  await db.schema
    .createIndex('oauth_access_tokens_session_id_idx')
    .on('oauth_access_tokens')
    .column('session_id')
    .execute()
  await db.schema.createIndex('oauth_access_tokens_user_id_idx').on('oauth_access_tokens').column('user_id').execute()
  await db.schema
    .createIndex('oauth_access_tokens_authorization_code_id_idx')
    .on('oauth_access_tokens')
    .column('authorization_code_id')
    .execute()
  await db.schema
    .createIndex('oauth_access_tokens_refresh_id_idx')
    .on('oauth_access_tokens')
    .column('refresh_id')
    .execute()
}
