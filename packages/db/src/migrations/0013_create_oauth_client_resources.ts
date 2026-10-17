import type { Kysely } from 'kysely'
import { authDateType, authJsonType, authStringType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'oauth_client_resources')
    .$call(autoIncrementId(db))
    .addColumn('client_id', authStringType(db, 255), (c) => c.notNull())
    .addColumn('resource_id', authStringType(db, 255), (c) => c.notNull())
    .addColumn('metadata', authJsonType(db))
    .addColumn('created_at', authDateType(db))
    .addForeignKeyConstraint(
      'oauth_client_resources_client_id_fk',
      ['client_id'],
      'oauth_clients',
      ['client_id'],
      (c) => c.onDelete('cascade'),
    )
    .addForeignKeyConstraint(
      'oauth_client_resources_resource_id_fk',
      ['resource_id'],
      'oauth_resources',
      ['identifier'],
      (c) => c.onDelete('cascade'),
    )
    .execute()
  await db.schema
    .createIndex('oauth_client_resources_client_id_idx')
    .on('oauth_client_resources')
    .column('client_id')
    .execute()
  await db.schema
    .createIndex('oauth_client_resources_resource_id_idx')
    .on('oauth_client_resources')
    .column('resource_id')
    .execute()
  await db.schema
    .createIndex('oauth_client_resources_client_id_resource_id_uidx')
    .on('oauth_client_resources')
    .columns(['client_id', 'resource_id'])
    .unique()
    .execute()
}
