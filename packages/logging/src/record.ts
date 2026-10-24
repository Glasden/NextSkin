/**
 * 日志记录的格式（ADR-0062）：一条一行 JSON。升级、回滚时新旧版本的启动器先后写同一个文件，
 * 所以只加字段、不改已有字段的含义；读的一侧照样显示不认识的字段，解析不了的行当作原始文本
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** 同 Pino 的数值，比较级别用 */
export const LOG_LEVEL_VALUES: Readonly<Record<LogLevel, number>> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

export type LogSource = 'launcher' | 'manager' | 'core' | 'plugin-host' | 'plugin'

/** 结构化字段。不放异常对象和异常消息，异常只记 `error.name`（不变量 11） */
export type LogFields = Record<string, unknown>

export interface LogRecord extends LogFields {
  /** UTC 的 ISO 时间，精确到毫秒 */
  time: string
  level: LogLevel
  /** 读文件时可能遇到以后的版本加的来源，所以是 string */
  source: string
  msg: string
  /** 模块：auth、mail、plugins……（原来行首的 `[auth]`） */
  area?: string
  /** 插件 id：`source` 是 `plugin` 时由核心填 */
  plugin?: string
  /** 进程的原始输出（Next 自己打印的、崩溃时的堆栈），不是 logger 写的 */
  raw?: boolean
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/** 解析一行；不是这个格式的返回 null */
export function parseLogRecord(line: string): LogRecord | null {
  if (!line.startsWith('{')) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.time !== 'string' ||
    !isLogLevel(record.level) ||
    typeof record.source !== 'string' ||
    typeof record.msg !== 'string'
  )
    return null
  return record as LogRecord
}
