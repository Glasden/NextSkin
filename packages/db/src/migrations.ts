import type { Kysely } from 'kysely'
import { Migrator, type Migration } from 'kysely/migration'

export interface MigrationOptions {
  migrationTableName?: string
  migrationLockTableName?: string
}

/** 迁移按字典序执行，名称请使用 0001_create_users 这样的前缀。 */
export async function migrateToLatest<DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration>,
  options: MigrationOptions = {},
): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve({ ...migrations }) },
    migrationTableName: options.migrationTableName ?? 'nextskin_migration',
    migrationLockTableName: options.migrationLockTableName ?? 'nextskin_migration_lock',
  })
  const { error, results } = await migrator.migrateToLatest()
  if (error) {
    const failed = results?.find((result) => result.status === 'Error')
    throw new Error(
      failed
        ? `迁移 ${failed.migrationName} 执行失败；请检查 cause 中的原因并修复后重试`
        : '迁移初始化或获取锁失败；请检查 cause 中的原因、连接和数据库权限后重试',
      { cause: error },
    )
  }
  return results?.filter((result) => result.status === 'Success').map((result) => result.migrationName) ?? []
}
