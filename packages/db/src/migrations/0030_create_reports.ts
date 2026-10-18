import { sql, type Kysely } from 'kysely'
import { autoIncrementId, createTable, isoTimestampColumn, longTextType } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'reports')
    .$call(autoIncrementId(db))
    .addColumn('texture_id', 'integer')
    .addColumn('uploader_id', 'integer')
    .addColumn('reporter_id', 'integer')
    .addColumn('reason', longTextType(db), (c) => c.notNull())
    .addColumn('score_paid', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('status', 'varchar(16)', (c) => c.notNull())
    .addColumn('resolution', 'varchar(32)')
    .addColumn('resolver_id', 'integer')
    .$call(isoTimestampColumn(db, 'created_at'))
    .$call(isoTimestampColumn(db, 'resolved_at', { nullable: true }))
    .addCheckConstraint('reports_status_check', sql`status in ('pending', 'resolved', 'rejected')`)
    .addCheckConstraint(
      'reports_resolution_check',
      sql`resolution in ('dismissed', 'textureDeleted', 'uploaderBanned')`,
    )
    .addForeignKeyConstraint('reports_texture_id_fk', ['texture_id'], 'textures', ['id'], (c) => c.onDelete('set null'))
    .addForeignKeyConstraint('reports_uploader_id_fk', ['uploader_id'], 'users', ['id'], (c) => c.onDelete('set null'))
    .addForeignKeyConstraint('reports_reporter_id_fk', ['reporter_id'], 'users', ['id'], (c) => c.onDelete('set null'))
    .addForeignKeyConstraint('reports_resolver_id_fk', ['resolver_id'], 'users', ['id'], (c) => c.onDelete('set null'))
    .execute()
  await db.schema
    .createIndex('reports_reporter_id_texture_id_unique')
    .on('reports')
    .columns(['reporter_id', 'texture_id'])
    .unique()
    .execute()
  await db.schema.createIndex('reports_status_id_index').on('reports').columns(['status', 'id']).execute()
  for (const column of ['texture_id', 'uploader_id', 'resolver_id'])
    await db.schema.createIndex(`reports_${column}_index`).on('reports').column(column).execute()
}
