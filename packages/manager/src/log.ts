import { createLogger, logLevelFromEnv, logFormatFromEnv, terminalWriter } from '@nextskin/logging'
import type { Logger } from '@nextskin/logging'

let logger: Logger | undefined

/** 管理进程自己的行（ADR-0062）：只写终端，格式同启动器和核心，来源 `manager`；启动器的输出照旧原样转发 */
export function managerLogger(): Logger {
  return (logger ??= createLogger('manager', {
    level: logLevelFromEnv(process.env),
    write: terminalWriter(logFormatFromEnv(process.env)),
  }))
}
