import { createApp } from '@nextskin/api'
import { coreConfigFromEnv, openCore, type Core } from '@nextskin/domain'

export interface Server {
  core: Core
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
  const { core } = await openCore(config)
  return { core, app: createApp({ core }) }
}
