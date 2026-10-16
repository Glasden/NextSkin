import { NodeSqliteDialect } from '@better-auth/kysely-adapter/node-sqlite-dialect'
import { Kysely, MysqlDialect, PostgresDialect, sql } from 'kysely'
import { createPool } from 'mysql2'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'

export type DialectName = 'sqlite' | 'postgres' | 'mysql'

export function createDb(dialect: DialectName): Kysely<any> {
  switch (dialect) {
    case 'sqlite':
      return new Kysely({ dialect: new NodeSqliteDialect({ database: new DatabaseSync(':memory:') }) })
    case 'postgres':
      return new Kysely({
        dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.PG_URL }) }),
      })
    case 'mysql':
      return new Kysely({ dialect: new MysqlDialect({ pool: createPool({ uri: process.env.MYSQL_URL }) }) })
  }
}

/** 核心自己的表（spike 里只需要 players）。Better Auth 的表由它自己的迁移创建。 */
export async function createCoreTables(db: Kysely<any>, dialect: DialectName) {
  const idType = dialect === 'postgres' ? 'serial' : 'integer'
  await db.schema
    .createTable('players')
    .addColumn('pid', idType, (col) => {
      col = col.primaryKey()
      return dialect === 'postgres' ? col : col.autoIncrement()
    })
    .addColumn('uid', 'integer', (col) => col.notNull())
    .addColumn('name', 'varchar(32)', (col) => col.notNull().unique())
    .addColumn('uuid', 'char(32)', (col) => col.notNull().unique())
    .execute()
}

export async function dropAll(db: Kysely<any>, dialect: DialectName) {
  if (dialect === 'sqlite') return
  const tables = await db.introspection.getTables()
  if (dialect === 'mysql') await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db)
  for (const table of tables) await db.schema.dropTable(table.name).cascade().ifExists().execute().catch(async () => {
    await db.schema.dropTable(table.name).ifExists().execute()
  })
  if (dialect === 'mysql') await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db)
}
