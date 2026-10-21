import { sql, type Kysely } from 'kysely'
import { dialectOf } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  const check = sql<boolean>`(plugin_id is null and plugin_key is null) or (plugin_id is not null and plugin_key is not null)`
  await db.schema.alterTable('score_transactions').addColumn('plugin_id', 'varchar(64)').execute()
  if (dialectOf(db) === 'sqlite') {
    // SQLite 不能追加表约束，列约束可以引用同一行的另一列。
    await db.schema
      .alterTable('score_transactions')
      .addColumn('plugin_key', 'varchar(255)', (c) =>
        c.modifyEnd(sql`constraint score_transactions_plugin_check check (${check})`),
      )
      .execute()
  } else {
    await db.schema.alterTable('score_transactions').addColumn('plugin_key', 'varchar(255)').execute()
    // MySQL 的列级 CHECK 不能引用别的列。
    await db.schema
      .alterTable('score_transactions')
      .addCheckConstraint('score_transactions_plugin_check', check)
      .execute()
  }
  await db.schema
    .createIndex('score_transactions_plugin_key_unique')
    .on('score_transactions')
    .columns(['plugin_id', 'plugin_key'])
    .unique()
    .execute()
  await db.schema
    .createIndex('score_transactions_plugin_id_id_index')
    .on('score_transactions')
    .columns(['plugin_id', 'id'])
    .execute()
}
