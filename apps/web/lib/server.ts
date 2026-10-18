import { createImportService, type ImportService } from '@nextskin/importer'
import { createApp } from '@nextskin/api'
import { coreConfigFromEnv, DomainError, openCore, type Core } from '@nextskin/domain'

export interface Server {
  core: Core
  importer: ImportService
  app: ReturnType<typeof createApp>
}

// Route Handler 和 proxy 可能各自打包出一份模块，靠 globalThis 共用同一个连接池；next dev 热更新后也不会重复连接
const holder = globalThis as typeof globalThis & { nextskinServer?: Promise<Server> }

/** 第一次调用时连接数据库并执行迁移（启动器落地之前由 Web 进程负责）。失败后下一次调用会重试 */
export function getServer(): Promise<Server> {
  holder.nextskinServer ??= open().catch((error: unknown) => {
    holder.nextskinServer = undefined
    throw error
  })
  return holder.nextskinServer
}

async function open(): Promise<Server> {
  const config = coreConfigFromEnv(process.env, {
    cwd: process.cwd(),
    production: process.env.NODE_ENV === 'production',
  })
  const opened = await openCore(config)
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
