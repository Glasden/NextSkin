import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { coreMigrations, createDatabase, migrateToLatest, type CoreDatabase } from '@nextskin/db'
import type { CoreConfig } from './config.ts'
import { createCore, type Core } from './core.ts'
import type { PluginHostEntry } from './plugins/host.ts'
import { createLocalPluginPackageStore, createPluginPackages } from './plugins/packages.ts'
import type { OfficialPlugin } from './plugins/system.ts'
import { createLocalRenderCache } from './textures/render-cache.ts'
import { createLocalTextureStorage } from './textures/storage.ts'

export { coreConfigFromEnv, type CoreConfig } from './config.ts'

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
    await migrateToLatest(db, coreMigrations)
    const renderCache = createLocalRenderCache(config.renderCacheDirectory)
    void renderCache.pruneOtherVersions().catch(() => console.warn('旧版出图缓存清理失败'))
    const core = createCore({
      setupCodeFile: join(config.dataDirectory, 'setup-code'),
      renderCache,
      db,
      textureStorage: createLocalTextureStorage(config.textureDirectory),
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
