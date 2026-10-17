import type { Kysely } from 'kysely'
import { authDateType, authStringType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'sessions')
    .$call(autoIncrementId(db))
    .addColumn('expires_at', authDateType(db), (c) => c.notNull())
    .addColumn('token', authStringType(db, 255), (c) => c.notNull())
    .addColumn('created_at', authDateType(db), (c) => c.notNull())
    .addColumn('updated_at', authDateType(db), (c) => c.notNull())
    .addColumn('ip_address', 'text')
    .addColumn('user_agent', 'text')
    .addColumn('user_id', 'integer', (c) => c.notNull())
    .addForeignKeyConstraint('sessions_user_id_fk', ['user_id'], 'users', ['id'], (c) => c.onDelete('cascade'))
    .execute()
  await db.schema.createIndex('sessions_token_uidx').on('sessions').column('token').unique().execute()
  await db.schema.createIndex('sessions_user_id_idx').on('sessions').column('user_id').execute()
}
