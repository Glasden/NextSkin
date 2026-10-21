import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { backupSqlite, coreMigrations, createDatabase, migrateToLatest, type CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import type { CoreConfig } from './config.ts'
import { createCore, type Core } from './core.ts'
import type { PluginHostEntry } from './plugins/host.ts'
import { createLocalPluginPackageStore, createPluginPackages } from './plugins/packages.ts'
import type { OfficialPlugin } from './plugins/system.ts'
import { createLocalRenderCache } from './textures/render-cache.ts'
import { createLocalTextureStorage } from './textures/storage.ts'
import { createLocalSiteImageStorage } from './site-images/storage.ts'

export { coreConfigFromEnv, type CoreConfig } from './config.ts'

type MigrationBackup = { backup: Promise<string>; failedAt?: number }
const migrationBackupsKey = Symbol.for('nextskin.migrationBackups')
// Next 会把领域层打进多个包；进程内的备份记录通过 globalThis 共用，仅在内存里，重启就会重新备份。
const holder = globalThis as typeof globalThis & { [migrationBackupsKey]?: Map<string, MigrationBackup> }
const migrationBackups = (holder[migrationBackupsKey] ??= new Map<string, MigrationBackup>())

/** SQLite 已有核心迁移时先备份，再升级；全新库和其他方言直接迁移（ADR-0040）。 */
export function migrateCore(db: Kysely<CoreDatabase>, config: CoreConfig): Promise<string[]> {
  const { database } = config
  // 单独的连接看不到同一个内存库；:memory: 直接迁移，不做文件备份。
  return migrateToLatest(
    db,
    coreMigrations,
    database.dialect === 'sqlite' && database.file !== ':memory:'
      ? {
          beforeUpgrade: async (pending) => {
            const key = JSON.stringify([resolve(database.file), pending])
            let attempt = migrationBackups.get(key)
            if (attempt?.failedAt !== undefined && Date.now() - attempt.failedAt >= 60_000) attempt = undefined
            const reused = attempt !== undefined
            if (!attempt) {
              const current: MigrationBackup = {
                backup: backupSqlite({
                  file: database.file,
                  directory: config.backupDirectory,
                  label: pending[0]!,
                }),
              }
              current.backup = current.backup.catch((error: unknown) => {
                current.failedAt = Date.now()
                throw error
              })
              migrationBackups.set(key, current)
              attempt = current
            }
            // 核心尚未打开，本进程没有改过库；同一批迁移沿用备份。期间手工改过库时须重启，清空内存记录后重新备份。
            const file = await attempt.backup
            console.info(
              reused
                ? `[nextskin] 有 ${pending.length} 个迁移要执行，沿用本进程为这批迁移做的备份 ${file}；核心打不开期间手工改过库的话，请重启服务，会重新备份`
                : `[nextskin] 有 ${pending.length} 个迁移要执行，已先把数据库备份到 ${file}`,
            )
          },
        }
      : {},
  )
}

/**
 * 连接数据库、执行核心迁移、启动任务执行器，返回领域层的入口。由核心进程在启动时调用。
 * 命令行脚本（例如 `nextskin set-role`）传 `startJobs: false`：只执行自己的用例，不去认领后台任务。
 * `pluginHost` 是 plugin host 的入口：由核心进程拉起 host（ADR-0039）；命令行脚本不传，
 * 安装插件在脚本里不运行，它们的拦截器按失败策略处理
 */
export async function openCore(
  config: CoreConfig,
  options: {
    startJobs?: boolean
    officialPlugins?: readonly OfficialPlugin[]
    pluginHost?: PluginHostEntry | null
  } = {},
): Promise<{ core: Core; close(): Promise<void> }> {
  if (config.database.dialect === 'sqlite') await mkdir(dirname(config.database.file), { recursive: true })
  const db = createDatabase<CoreDatabase>(config.database)
  try {
    await migrateCore(db, config)
    const renderCache = createLocalRenderCache(config.renderCacheDirectory)
    void renderCache.pruneOtherVersions().catch(() => console.warn('旧版出图缓存清理失败'))
    const core = createCore({
      setupCodeFile: join(config.dataDirectory, 'setup-code'),
      renderCache,
      db,
      textureStorage: createLocalTextureStorage(config.textureDirectory),
      siteImageStorage: createLocalSiteImageStorage(config.siteImageDirectory),
      secretKey: config.secretKey,
      production: config.production,
      plugins: {
        official: options.officialPlugins ?? [],
        sqliteFile: config.database.dialect === 'sqlite' ? config.database.file : undefined,
        host: options.pluginHost ?? null,
        packages: createPluginPackages({
          directory: config.pluginDirectory,
          store: createLocalPluginPackageStore(config.pluginPackageDirectory),
        }),
      },
    })
    // 先切到表里启用的插件，再启动执行器：插件的任务处理函数和定时任务要先登记上。
    // 命令行脚本也要切：它们的用例发出的事件同样要展开给已启用的插件
    await core.plugins.start()
    if (options.startJobs !== false) {
      const code = await core.setup.prepareCode()
      if (code?.status === 'created' || code?.status === 'kept')
        console.info(`[setup] 站点还没有初始化：打开 /setup 完成安装，安装码在 ${code.file}`)
      core.jobs.start()
      core.schedules.start()
    }
    return {
      core,
      async close() {
        await core.schedules.stop()
        await core.jobs.stop()
        await core.shutdown()
        await db.destroy()
      },
    }
  } catch (error) {
    await db.destroy()
    throw error
  }
}
