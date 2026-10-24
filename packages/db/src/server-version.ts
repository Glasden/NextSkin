import { sql, type Kysely } from 'kysely'
import { dialectOf } from './helpers.ts'

/** MariaDB 与 MySQL 共用 version()；连接失败由调用方决定怎样呈现。 */
export async function databaseServerVersion<DB>(db: Kysely<DB>): Promise<string> {
  const expression = {
    sqlite: sql<string>`sqlite_version()`,
    mysql: sql<string>`version()`,
    postgres: sql<string>`current_setting('server_version')`,
  }[dialectOf(db)]
  const { rows } = await sql<{ version: string }>`select ${expression} as version`.execute(db)
  return rows[0]!.version
}
