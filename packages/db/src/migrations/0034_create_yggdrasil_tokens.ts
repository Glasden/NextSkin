import type { Kysely } from 'kysely'
import { autoIncrementId, createTable, isoTimestampColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'yggdrasil_tokens')
    .$call(autoIncrementId(db))
    .addColumn('access_token_hash', 'varchar(64)', (c) => c.notNull().unique())
    .addColumn('client_token', 'varchar(255)', (c) => c.notNull())
    .addColumn('user_id', 'integer', (c) => c.notNull())
    .addColumn('player_id', 'integer')
    .$call(isoTimestampColumn(db, 'created_at'))
    .$call(isoTimestampColumn(db, 'valid_until'))
    .$call(isoTimestampColumn(db, 'expires_at'))
    .addForeignKeyConstraint('yggdrasil_tokens_user_id_fk', ['user_id'], 'users', ['id'], (c) => c.onDelete('cascade'))
    .addForeignKeyConstraint('yggdrasil_tokens_player_id_fk', ['player_id'], 'players', ['id'], (c) =>
      c.onDelete('cascade'),
    )
    .execute()
  await db.schema
    .createIndex('yggdrasil_tokens_user_id_id_index')
    .on('yggdrasil_tokens')
    .columns(['user_id', 'id'])
    .execute()
  await db.schema.createIndex('yggdrasil_tokens_expires_at_index').on('yggdrasil_tokens').column('expires_at').execute()
}
