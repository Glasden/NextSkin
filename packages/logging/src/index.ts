// 日志（ADR-0062）：记录的格式、给人看的一行文本、基于 Pino 的 logger、按大小轮换的日志文件、核心经 IPC 交给启动器的消息。
// 核心各处用 getLogger(模块)，需要注入的地方接 Logger，测试用 createMemoryLogger 或 captureLogs
export {
  isLogLevel,
  LOG_LEVEL_VALUES,
  LOG_LEVELS,
  parseLogRecord,
  type LogFields,
  type LogLevel,
  type LogRecord,
  type LogSource,
} from './record.ts'
export { formatLocalTime, formatLogText } from './format.ts'
export { createLogger, createMemoryLogger, discardLogger, type LogTarget, type Logger } from './logger.ts'
export {
  DEFAULT_LOG_FILE_LIMITS,
  isLogFileLimits,
  LOG_DIRECTORY,
  LOG_FILE,
  LOG_FILE_LIMIT_RANGES,
  openLogFile,
  rotatedLogFile,
  type LogFile,
  type LogFileLimits,
  type LogFileOptions,
} from './file.ts'
export {
  ipcLogWriter,
  logLimitsFromMessage,
  logLineFromMessage,
  type IpcChannel,
  type LogConfigMessage,
  type LogMessage,
} from './ipc.ts'
export { lineSplitter } from './lines.ts'
export {
  captureLogs,
  configureRootLogger,
  getLogger,
  logFileEnabledFromEnv,
  logFormatFromEnv,
  logLevelFromEnv,
  rootLogger,
  terminalWriter,
  type LogFormat,
} from './root.ts'
