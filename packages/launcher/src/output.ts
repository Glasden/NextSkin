import { join } from 'node:path'
import {
  createLogger,
  lineSplitter,
  LOG_DIRECTORY,
  logFileEnabledFromEnv,
  logFormatFromEnv,
  logLevelFromEnv,
  openLogFile,
  redactSecrets,
  terminalWriter,
  type LogFile,
  type LogFileLimits,
  type Logger,
} from '@nextskin/logging'

/** 核心的原始输出一行最多这么多字符，同 plugin host 的 stderr */
const MAX_RAW_LINE = 2000
/** 打开日志文件之前（等数据目录的锁时）的记录先攒着，打开后补进文件 */
const MAX_EARLY_LINES = 100
/**
 * 启动器的 stdout、stderr 里等着被读走的超过这么多时丢掉新的（只丢终端这一路，文件照写）：
 * 读终端的一方（面板、管理进程的上游）停住时，POSIX 上往管道写是异步的，不限就一直攒在内存里
 */
const MAX_TERMINAL_PENDING = 4 * 1024 * 1024

/**
 * `start` 的出口（ADR-0062）：启动器自己的记录、核心经 IPC 发来的记录、核心 stdout 和 stderr 的原始行，
 * 一起写终端和数据目录里的日志文件
 */
export interface LauncherOutput {
  /** 启动器自己的记录，来源 `launcher` */
  readonly logger: Logger
  /** 核心经 IPC 发来的一条记录，原样写出 */
  write(line: string): void
  /** 核心 stdout（记 info）、stderr（记 warn）的原始输出，按行记成来源 `core`、`raw: true`，机密形状的内容换成 `[redacted]` */
  raw(stream: 'stdout' | 'stderr'): { push(chunk: string): void; end(): void }
  /** 拿到数据目录的锁之后才写文件：一个数据目录只有一个写入方。`NEXTSKIN_LOG_FILE=off` 时不写 */
  openFile(dataDirectory: string): void
  /** 核心读到的轮换上限 */
  configure(limits: LogFileLimits): void
  /** 写完排着的记录、关掉文件 */
  close(): Promise<void>
}

/**
 * 级别、终端的格式和文件的开关每次用到时按 `env` 取：`start` 一开始就要写日志，`.env` 的值之后才合并进来。
 * `terminal` 默认写启动器的 stdout、stderr，测试换成收集的函数
 */
export function createLauncherOutput(env: NodeJS.ProcessEnv, terminal?: (line: string) => void): LauncherOutput {
  let file: LogFile | undefined
  let early: string[] | undefined = []
  const toTerminal =
    terminal ??
    boundedTerminal(
      (line) => terminalWriter(logFormatFromEnv(env))(line),
      () => process.stdout.writableLength + process.stderr.writableLength,
      (dropped) => logger.warn('终端的输出没被及时读走，有记录没写到终端', { dropped }),
    )
  const write = (line: string) => {
    toTerminal(line)
    if (file) file.write(line)
    else if (early && early.length < MAX_EARLY_LINES) early.push(line)
  }
  const target = {
    get level() {
      return logLevelFromEnv(env)
    },
    write,
  }
  const logger = createLogger('launcher', target)
  const core = createLogger('core', target).child({ raw: true })
  return {
    logger,
    write,
    // Next 和第三方库打印的内容核心管不住：机密形状的先换掉
    raw: (stream) =>
      lineSplitter(MAX_RAW_LINE, (line) => {
        const text = redactSecrets(line)
        if (stream === 'stdout') core.info(text)
        else core.warn(text)
      }),
    openFile(dataDirectory) {
      const lines = early ?? []
      early = undefined
      if (file || !logFileEnabledFromEnv(env)) return
      file = openLogFile({ directory: join(dataDirectory, LOG_DIRECTORY), report: logger })
      for (const line of lines) file.write(line)
    },
    configure: (limits) => file?.configure(limits),
    close: async () => {
      early = undefined
      await file?.close()
    },
  }
}

/**
 * 写终端；`pending()`（还没被读走的字节数）超过上限时丢掉、记下条数，恢复后经 `report` 补一条。
 * 补的这一条也写终端，不受上限限制：否则它刚好又越过上限时会被丢掉，计数跟着丢了
 */
export function boundedTerminal(
  write: (line: string) => void,
  pending: () => number,
  report: (dropped: number) => void,
  limit = MAX_TERMINAL_PENDING,
): (line: string) => void {
  let dropped = 0
  let reporting = false
  return (line) => {
    if (!reporting && pending() > limit) {
      dropped++
      return
    }
    write(line)
    if (dropped === 0 || reporting) return
    const count = dropped
    dropped = 0
    reporting = true
    try {
      report(count)
    } finally {
      reporting = false
    }
  }
}
