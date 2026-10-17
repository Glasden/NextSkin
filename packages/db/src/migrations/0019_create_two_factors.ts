import type { Kysely } from 'kysely'
import { authBooleanType, authDateType, authStringType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'two_factors')
    .$call(autoIncrementId(db))
    .addColumn('secret', authStringType(db, 255), (c) => c.notNull())
    .addColumn('backup_codes', 'text', (c) => c.notNull())
    .addColumn('user_id', 'integer', (c) => c.notNull())
    .addColumn('verified', authBooleanType(db))
    .addColumn('failed_verification_count', 'integer')
    .addColumn('locked_until', authDateType(db))
    .addForeignKeyConstraint('two_factors_user_id_fk', ['user_id'], 'users', ['id'], (c) => c.onDelete('cascade'))
    .execute()
  await db.schema.createIndex('two_factors_secret_idx').on('two_factors').column('secret').execute()
  await db.schema.createIndex('two_factors_user_id_idx').on('two_factors').column('user_id').execute()
}
