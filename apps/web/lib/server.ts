import { resolve } from 'node:path'
import { createImportService, type ImportService } from '@nextskin/importer'
import { createApp } from '@nextskin/api'
import { coreConfigFromEnv, DomainError, openCore, pluginHostEntry, type Core } from '@nextskin/domain'
import { officialPlugins } from '@nextskin/official-plugins'

export interface Server {
  core: Core
  importer: ImportService
  app: ReturnType<typeof createApp>
}

// Route Handler 和 proxy 可能各自打包出一份模块，靠 globalThis 共用同一个连接池；next dev 热更新后也不会重复连接
const holder = globalThis as typeof globalThis & { nextskinServer?: Promise<Server> }

/**
 * 第一次调用时连接数据库并执行迁移（由核心进程负责）。失败后下一次调用会重试。
 * `next build` 期间一律拒绝：构建的环境里有密钥时，打开核心会对构建时配置的库执行迁移
 */
export function getServer(): Promise<Server> {
  if (process.env.NEXT_PHASE === 'phase-production-build')
    return Promise.reject(new Error('构建期间不打开核心：页面应当动态渲染（app/layout.tsx）'))
  holder.nextskinServer ??= open().catch((error: unknown) => {
    holder.nextskinServer = undefined
    throw error
  })
  return holder.nextskinServer
}

/** 现在缓存的那一次打开（可能还在进行），不触发新的打开。停止时用它收掉后台任务（lib/launcher-channel.ts） */
export function openedServer(): Promise<Server> | undefined {
  return holder.nextskinServer
}

async function open(): Promise<Server> {
  const production = process.env.NODE_ENV === 'production'
  const config = coreConfigFromEnv(process.env, { cwd: process.cwd(), production })
  // 工作目录是 apps/web（next dev）或 standalone 产物里的 apps/web（server.js 会切过去），上两级是根目录。
  // 产物里运行打好包的 host，它由 next.config.ts 的 outputFileTracingIncludes 带进去
  const pluginHost = pluginHostEntry({ root: resolve(process.cwd(), '../..'), bundled: production })
  const opened = await openCore(config, { officialPlugins, pluginHost })
  const { core } = opened
  try {
    const importer = await createImportService({
      database: config.database,
      textureDirectory: config.textureDirectory,
      secretKey: config.secretKey,
      maintenance: {
        async enter() {
          await core.schedules.stop()
          if (!(await core.jobs.quiesce(60_000))) {
            core.jobs.start()
            core.schedules.start()
            throw new DomainError('import_jobs_busy')
          }
        },
        exit() {
          core.jobs.start()
          core.schedules.start()
          return Promise.resolve()
        },
      },
      onImported: () => core.setup.removeCode(),
    })
    return { core, importer, app: createApp({ core, importer }) }
  } catch (error) {
    await opened.close()
    throw error
  }
}
