import { sql, type Kysely } from 'kysely'
import { autoIncrementId, createTable, isoTimestampColumn, longTextType } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'notification_broadcasts')
    .$call(autoIncrementId(db))
    .addColumn('sender_id', 'integer')
    .addColumn('audience', 'varchar(16)', (c) => c.notNull())
    .addColumn('title', 'varchar(255)', (c) => c.notNull())
    .addColumn('body', longTextType(db), (c) => c.notNull())
    .addColumn('through_uid', 'integer', (c) => c.notNull())
    .addColumn('cursor_uid', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('recipient_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('status', 'varchar(16)', (c) => c.notNull())
    .$call(isoTimestampColumn(db, 'created_at'))
    .$call(isoTimestampColumn(db, 'finished_at', { nullable: true }))
    .addCheckConstraint(
      'notification_broadcasts_audience_check',
      sql`audience in ('all', 'users', 'admins', 'specific')`,
    )
    .addCheckConstraint('notification_broadcasts_status_check', sql`status in ('sending', 'sent', 'recalled')`)
    .addForeignKeyConstraint('notification_broadcasts_sender_fk', ['sender_id'], 'users', ['id'], (c) =>
      c.onDelete('set null'),
    )
    .execute()
  await db.schema
    .createIndex('notification_broadcasts_sender_index')
    .on('notification_broadcasts')
    .column('sender_id')
    .execute()
  await createTable(db, 'notifications')
    .$call(autoIncrementId(db))
    .addColumn('user_id', 'integer', (c) => c.notNull())
    .addColumn('type', 'varchar(32)', (c) => c.notNull())
    .addColumn('params', longTextType(db))
    .addColumn('broadcast_id', 'integer')
    .addColumn('plugin_id', 'varchar(64)')
    .addColumn('title_key', 'varchar(128)')
    .addColumn('body_key', 'varchar(128)')
    .addColumn('link', 'varchar(500)')
    .$call(isoTimestampColumn(db, 'read_at', { nullable: true }))
    .$call(isoTimestampColumn(db, 'created_at'))
    .addForeignKeyConstraint('notifications_user_fk', ['user_id'], 'users', ['id'], (c) => c.onDelete('cascade'))
    .addForeignKeyConstraint('notifications_broadcast_fk', ['broadcast_id'], 'notification_broadcasts', ['id'], (c) =>
      c.onDelete('cascade'),
    )
    .execute()
  for (const columns of [
    ['user_id', 'read_at'],
    ['user_id', 'id'],
    ['plugin_id', 'id'],
  ])
    await db.schema
      .createIndex(`notifications_${columns.join('_')}_index`)
      .on('notifications')
      .columns(columns)
      .execute()
  await db.schema
    .createIndex('notifications_broadcast_user_unique')
    .on('notifications')
    .columns(['broadcast_id', 'user_id'])
    .unique()
    .execute()
  await createTable(db, 'plugin_notification_keys')
    .addColumn('plugin_id', 'varchar(64)', (c) => c.notNull())
    .addColumn('plugin_key', 'varchar(255)', (c) => c.notNull())
    .addColumn('user_id', 'integer', (c) => c.notNull())
    .addColumn('fingerprint', 'char(64)', (c) => c.notNull())
    .$call(isoTimestampColumn(db, 'created_at'))
    .addPrimaryKeyConstraint('plugin_notification_keys_pk', ['plugin_id', 'plugin_key'])
    .execute()
}
