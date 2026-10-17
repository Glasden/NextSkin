import type { Kysely } from 'kysely'
import { autoIncrementId, createTable, isoTimestampColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'score_transactions')
    .$call(autoIncrementId(db))
    .addColumn('user_id', 'integer', (c) => c.notNull())
    .addColumn('delta', 'integer', (c) => c.notNull())
    .addColumn('balance', 'integer', (c) => c.notNull())
    .addColumn('reason', 'varchar(128)', (c) => c.notNull())
    .addColumn('subject_type', 'varchar(32)')
    .addColumn('subject_id', 'integer')
    .$call(isoTimestampColumn(db, 'created_at'))
    .addForeignKeyConstraint('score_transactions_user_id_fk', ['user_id'], 'users', ['id'], (c) =>
      c.onDelete('cascade'),
    )
    .execute()
  await db.schema
    .createIndex('score_transactions_user_id_id_index')
    .on('score_transactions')
    .columns(['user_id', 'id'])
    .execute()
}
