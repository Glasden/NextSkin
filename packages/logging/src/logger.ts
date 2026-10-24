import pino, { type Logger as PinoLogger } from 'pino'
import { LOG_LEVEL_VALUES, type LogFields, type LogLevel, type LogRecord, type LogSource } from './record.ts'

/**
 * 核心各处用的 logger。消息用固定的事件码（`password_event_failed`）或给站长看的句子，不拼异常的消息；
 * 字段里不放异常对象，异常只记 `error.name`（不变量 11）
 */
export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /**
   * 带上固定字段（`area`、`plugin`……）的子 logger，和父 logger 写到同一个出口、同一个级别。
   * bindings 里有 `source` 时换掉来源（插件、plugin host 写的记录），不会出现两个 `source`
   */
  child(bindings: LogFields & { source?: LogSource }): Logger
}

/**
 * 按字段名兜底（ADR-0062）：顶层和下一层叫这些名字的值换成 `[redacted]`。
 * 只是兜底：插件的 fields 再往下的层、拼进消息里的内容都管不到，不变量 11 照旧由写日志的地方自己守
 */
const REDACTED_NAMES = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'secret',
  'clientSecret',
  'cookie',
  'authorization',
  'databaseUrl',
]
const REDACT_PATHS = REDACTED_NAMES.flatMap((name) => [name, `*.${name}`])

/** 出口和级别可以在运行时换：启动器接管输出、测试捕获记录时，已经取到的子 logger 也跟着换 */
export interface LogTarget {
  /** 低于这个级别的不记 */
  level: LogLevel
  /** 一条记录一行 JSON，不带换行 */
  write(line: string): void
}

export function createLogger(source: LogSource, target: LogTarget): Logger {
  // 换来源的子 logger 要另起一个 Pino 实例（来源在 base 里）。每个来源只建一次：插件每次 ctx.log 都会派生，
  // 建实例要编译 redact
  const roots = new Map<LogSource, PinoLogger>()
  const rootFor = (next: LogSource) => {
    let instance = roots.get(next)
    if (!instance) roots.set(next, (instance = createPino(next, target)))
    return instance
  }
  return wrap(rootFor(source), source, rootFor, target)
}

function createPino(source: LogSource, target: LogTarget): PinoLogger {
  return pino(
    {
      // 级别由 wrap 按 target.level 判断：Pino 的子 logger 在创建时就定了级别，之后改不了
      level: 'debug',
      base: { source },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    { write: (line: string) => target.write(line.endsWith('\n') ? line.slice(0, -1) : line) },
  )
}

function wrap(
  instance: PinoLogger,
  source: LogSource,
  rootFor: (source: LogSource) => PinoLogger,
  target: LogTarget,
): Logger {
  const at =
    (level: Exclude<LogLevel, 'fatal'>) =>
    (msg: string, fields?: LogFields): void => {
      if (LOG_LEVEL_VALUES[level] < LOG_LEVEL_VALUES[target.level]) return
      instance[level](fields ?? {}, msg)
    }
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: ({ source: next = source, ...bindings }) => {
      // 不用 instance.child：Pino 的子 logger 只往后追加，覆盖已有的字段（area）、换来源时会写出两个同名的键。
      // 从那个来源的实例派生，带上合并后的 bindings；bindings() 里也有 base 的 source，要去掉
      const existing = { ...instance.bindings() }
      delete existing.source
      return wrap(rootFor(next).child({ ...existing, ...bindings }), next, rootFor, target)
    },
  }
}

/** 什么都不记：有自己的输出的命令行（`plugin`）用它关掉插件系统的日志 */
export const discardLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => discardLogger,
}

/** 测试用：记录解析后收进数组，和正式的出口走同一套格式和 redact */
export function createMemoryLogger(options: { source?: LogSource; level?: LogLevel } = {}): {
  logger: Logger
  records: LogRecord[]
} {
  const records: LogRecord[] = []
  const logger = createLogger(options.source ?? 'core', {
    level: options.level ?? 'debug',
    write: (line) => void records.push(JSON.parse(line) as LogRecord),
  })
  return { logger, records }
}
