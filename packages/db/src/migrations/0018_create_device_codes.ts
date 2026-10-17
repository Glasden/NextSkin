import type { Kysely } from 'kysely'
import { authDateType, authJsonType, authStringType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'device_codes')
    .$call(autoIncrementId(db))
    .addColumn('device_code', authStringType(db, 255), (c) => c.notNull())
    .addColumn('user_code', authStringType(db, 255), (c) => c.notNull())
    .addColumn('user_id', 'text')
    .addColumn('expires_at', authDateType(db), (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('last_polled_at', authDateType(db))
    .addColumn('polling_interval', 'integer')
    .addColumn('client_id', authStringType(db, 255))
    .addColumn('scope', 'text')
    .addColumn('resources', authJsonType(db))
    .addColumn('oauth_client_id', 'text')
    .execute()
  await db.schema
    .createIndex('device_codes_device_code_uidx')
    .on('device_codes')
    .columns(['device_code'])
    .unique()
    .execute()
  await db.schema
    .createIndex('device_codes_user_code_uidx')
    .on('device_codes')
    .columns(['user_code'])
    .unique()
    .execute()
}
