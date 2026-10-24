// 日志（ADR-0062）：记录的格式、给人看的一行文本、基于 Pino 的 logger。核心各处用 getLogger(模块)，
// 需要注入的地方接 Logger，测试用 createMemoryLogger 或 captureLogs
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
  captureLogs,
  configureRootLogger,
  getLogger,
  logFormatFromEnv,
  logLevelFromEnv,
  rootLogger,
  terminalWriter,
  type LogFormat,
} from './root.ts'
