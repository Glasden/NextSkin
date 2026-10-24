import { formatLogText } from './format.ts'
import { createLogger, type LogTarget, type Logger } from './logger.ts'
import { isLogLevel, LOG_LEVEL_VALUES, parseLogRecord, type LogLevel, type LogRecord } from './record.ts'

export type LogFormat = 'text' | 'json'

interface RootState {
  /** 没设置时第一次用到才按环境变量取：命令行在加载 .env 之前就导入了这些模块 */
  level: LogLevel | undefined
  write: ((line: string) => void) | undefined
  logger: Logger
}

// 一个进程一份：Next 会把同一个模块打进几个 chunk，开发时热更新也会重新执行模块
const holder = globalThis as typeof globalThis & { nextskinRootLogger?: RootState }

function state(): RootState {
  if (holder.nextskinRootLogger) return holder.nextskinRootLogger
  const target: LogTarget = {
    get level() {
      return (current.level ??= logLevelFromEnv(process.env))
    },
    write(line) {
      ;(current.write ??= terminalWriter(logFormatFromEnv(process.env)))(line)
    },
  }
  const current: RootState = { level: undefined, write: undefined, logger: createLogger('core', target) }
  holder.nextskinRootLogger = current
  return current
}

/** 核心进程的 logger，来源是 `core` */
export function rootLogger(): Logger {
  return state().logger
}

/** 某个模块的 logger：`getLogger('auth')` 写出的记录带 `area: 'auth'` */
export function getLogger(area: string): Logger {
  return rootLogger().child({ area })
}

/** 换掉级别或出口；已经取到的子 logger 也跟着换（ADR-0062：由启动器拉起时改经 IPC 发出） */
export function configureRootLogger(options: { level?: LogLevel; write?: (line: string) => void }): void {
  const current = state()
  if (options.level) current.level = options.level
  if (options.write) current.write = options.write
}

/**
 * 测试用：之后的记录（含 debug）收进 `records`，不写终端；`restore()` 换回原来的级别和出口。
 * 只适合不并发的测试：整个进程共用一个 root logger
 */
export function captureLogs(): { records: LogRecord[]; restore: () => void } {
  const current = state()
  const saved = { level: current.level, write: current.write }
  const records: LogRecord[] = []
  current.level = 'debug'
  current.write = (line) => void records.push(JSON.parse(line) as LogRecord)
  return {
    records,
    restore: () => {
      current.level = saved.level
      current.write = saved.write
    },
  }
}

/** `NEXTSKIN_LOG_LEVEL`：debug、info、warn、error；没设、认不出时 `pnpm dev` 是 debug，其余是 info */
export function logLevelFromEnv(env: Readonly<Record<string, string | undefined>>): LogLevel {
  const value = env.NEXTSKIN_LOG_LEVEL?.trim().toLowerCase()
  if (isLogLevel(value)) return value
  return env.NODE_ENV === 'development' ? 'debug' : 'info'
}

/** `NEXTSKIN_LOG_FORMAT`：`json` 时写 NDJSON，其余写给人看的一行 */
export function logFormatFromEnv(env: Readonly<Record<string, string | undefined>>): LogFormat {
  return env.NEXTSKIN_LOG_FORMAT?.trim().toLowerCase() === 'json' ? 'json' : 'text'
}

/** 终端的流：process.stdout、process.stderr，测试传普通对象 */
export interface TerminalStream {
  write(text: string, callback?: (error?: Error | null) => void): unknown
  once?(event: 'error', listener: () => void): unknown
  listenerCount?(event: 'error'): number
}

/** 写终端：warn 及以上写 stderr，其余写 stdout */
export function terminalWriter(
  format: LogFormat,
  streams: { stdout: TerminalStream; stderr: TerminalStream } = process,
): (line: string) => void {
  return (line) => {
    const record = parseLogRecord(line)
    const stream = record && LOG_LEVEL_VALUES[record.level] >= LOG_LEVEL_VALUES.warn ? streams.stderr : streams.stdout
    write(stream, `${format === 'text' && record ? formatLogText(record) : line}\n`)
  }
}

/**
 * 同 Node 的 console：读终端的一端关了（EPIPE，例如 `nextskin migrate | head`、面板断开了输出）时，写日志不能让进程崩溃。
 * 写失败时流随后会发 error 事件，没有监听者就成了未捕获的异常，所以在回调里挂一个空的监听者接住它
 */
function write(stream: TerminalStream, text: string): void {
  try {
    stream.write(text, (error) => {
      if (error && stream.listenerCount?.('error') === 0) stream.once?.('error', () => {})
    })
  } catch {
    // 同步抛出的（流已经销毁）同样丢掉这一条
  }
}
