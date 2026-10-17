import type { Kysely } from 'kysely'
import { authDateType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'accounts')
    .$call(autoIncrementId(db))
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('provider_id', 'text', (c) => c.notNull())
    .addColumn('user_id', 'integer', (c) => c.notNull())
    .addColumn('access_token', 'text')
    .addColumn('refresh_token', 'text')
    .addColumn('id_token', 'text')
    .addColumn('access_token_expires_at', authDateType(db))
    .addColumn('refresh_token_expires_at', authDateType(db))
    .addColumn('scope', 'text')
    .addColumn('password', 'text')
    .addColumn('created_at', authDateType(db), (c) => c.notNull())
    .addColumn('updated_at', authDateType(db), (c) => c.notNull())
    .addForeignKeyConstraint('accounts_user_id_fk', ['user_id'], 'users', ['id'], (c) => c.onDelete('cascade'))
    .execute()
  await db.schema.createIndex('accounts_user_id_idx').on('accounts').column('user_id').execute()
}
