// 核心的日志出口（ADR-0062）。由启动器拉起时，记录经 IPC 发给启动器，由它写终端和日志文件，通道断开后改写 stderr；
// pnpm dev、直接运行 server.js 时自己写终端和数据目录里的日志文件（收不到 Next 自己的输出）。
// 轮换的上限存在设置里：核心打开后读一次，之后每分钟读一次，变了才交给写文件的一方
import { join } from 'node:path'
import { coreConfigFromEnv, type Core } from '@nextskin/domain'
import {
  configureRootLogger,
  getLogger,
  ipcLogWriter,
  LOG_DIRECTORY,
  logFileEnabledFromEnv,
  logFormatFromEnv,
  openLogFile,
  terminalWriter,
  type LogConfigMessage,
  type LogFileLimits,
} from '@nextskin/logging'

const holder = globalThis as typeof globalThis & { nextskinLogLimits?: (limits: LogFileLimits) => void }

/** 换掉 root logger 的出口；要在打开核心、写第一条记录之前调用 */
export function connectLogging(): void {
  if (holder.nextskinLogLimits) return
  const format = logFormatFromEnv(process.env)
  if (process.env.NEXTSKIN_LAUNCHER_IPC === '1' && process.send) {
    const stderr = terminalWriter(format, { stdout: process.stderr, stderr: process.stderr })
    configureRootLogger({ write: ipcLogWriter(process, stderr) })
    holder.nextskinLogLimits = (limits) => {
      if (!process.connected) return
      try {
        process.send?.({ nextskin: 'logConfig', ...limits } satisfies LogConfigMessage, () => {
          /* 通道可能正随着启动器退出而关闭 */
        })
      } catch {
        /* 同上 */
      }
    }
    return
  }
  const terminal = terminalWriter(format)
  const directory = logDirectory()
  const file = directory ? openLogFile({ directory, report: getLogger('logging') }) : undefined
  configureRootLogger({
    write: (line) => {
      terminal(line)
      file?.write(line)
    },
  })
  holder.nextskinLogLimits = (limits) => file?.configure(limits)
}

/** 不写文件（`NEXTSKIN_LOG_FILE=off`、配置有误）时返回 undefined；配置的错误留给打开核心时报 */
function logDirectory(): string | undefined {
  if (!logFileEnabledFromEnv(process.env)) return undefined
  try {
    const production = process.env.NODE_ENV === 'production'
    return join(coreConfigFromEnv(process.env, { cwd: process.cwd(), production }).dataDirectory, LOG_DIRECTORY)
  } catch {
    return undefined
  }
}

/**
 * 每分钟读一次轮换的上限，变了才交出去。`current` 取现在缓存的那一次打开（lib/server.ts 的 openedServer），
 * 不触发新的打开：打不开数据库时启动器用默认值，等请求把核心重新打开
 */
export function watchLogLimits(
  current: () => Promise<{ core: Pick<Core, 'settings'> }> | undefined,
  apply: (limits: LogFileLimits) => void = (limits) => holder.nextskinLogLimits?.(limits),
  interval = 60_000,
): () => void {
  let last: string | undefined
  const check = async () => {
    const server = await current()?.catch(() => undefined)
    if (!server) return
    try {
      const values = await server.core.settings.read(['logging.maxFileSizeMb', 'logging.maxFiles'])
      const limits = { maxFileSizeMb: values['logging.maxFileSizeMb'], maxFiles: values['logging.maxFiles'] }
      const key = JSON.stringify(limits)
      if (key === last) return
      last = key
      apply(limits)
    } catch {
      // 数据库暂时不可用：下一分钟再读
    }
  }
  void check()
  const timer = setInterval(() => void check(), interval)
  timer.unref()
  return () => clearInterval(timer)
}
