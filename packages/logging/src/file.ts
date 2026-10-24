import { chmod, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from './logger.ts'

/** 数据目录下的日志目录（ADR-0062） */
export const LOG_DIRECTORY = 'logs'
/** 当前的文件；轮换出来的是 `nextskin.1.log`（最新）、`nextskin.2.log`…… */
export const LOG_FILE = 'nextskin.log'
/** 上次收到的轮换上限，放在日志目录里：重启后、核心打开数据库之前照它轮换 */
export const LOG_LIMITS_FILE = 'limits.json'

export function rotatedLogFile(index: number): string {
  return `nextskin.${index}.log`
}

/** 轮换的上限：后台"高级"分区的 `logging.maxFileSizeMb`、`logging.maxFiles` */
export interface LogFileLimits {
  /** 单个文件的上限，MB */
  maxFileSizeMb: number
  /** 连同当前文件一共留几份 */
  maxFiles: number
}

export const DEFAULT_LOG_FILE_LIMITS: Readonly<LogFileLimits> = { maxFileSizeMb: 10, maxFiles: 5 }

/** 设置项的取值范围。至少 2 份：只留 1 份时，每次轮换都会清空全部日志 */
export const LOG_FILE_LIMIT_RANGES = {
  maxFileSizeMb: { min: 1, max: 100 },
  maxFiles: { min: 2, max: 20 },
} as const

export function isLogFileLimits(value: unknown): value is LogFileLimits {
  if (typeof value !== 'object' || value === null) return false
  const { maxFileSizeMb, maxFiles } = value as Record<string, unknown>
  const within = (item: unknown, range: { min: number; max: number }) =>
    Number.isInteger(item) && (item as number) >= range.min && (item as number) <= range.max
  return within(maxFileSizeMb, LOG_FILE_LIMIT_RANGES.maxFileSizeMb) && within(maxFiles, LOG_FILE_LIMIT_RANGES.maxFiles)
}

/** 用到的文件操作，测试换成会失败的 */
export interface LogFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  open(path: string, flags: 'a', mode: number): Promise<LogFileHandle>
  chmod(path: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
  readdir(path: string): Promise<string[]>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>
}

export interface LogFileHandle {
  stat(): Promise<{ size: number }>
  appendFile(data: string): Promise<void>
  close(): Promise<void>
}

const nodeFileSystem: LogFileSystem = { mkdir, open, chmod, rename, rm, readdir, readFile, writeFile }

export interface LogFileOptions {
  /** `<数据目录>/logs` */
  directory: string
  /** 丢了记录、写不进去、轮换失败时的提示写到这里，和其余记录同一个出口 */
  report: Logger
  /** 一开始的上限；不给就用上次收到的（`limits.json`），没有再用默认值。`configure` 可以随时换 */
  limits?: LogFileLimits
  /** 等着写盘的内容的上限，默认 4 MB */
  maxPending?: number
  fs?: LogFileSystem
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface LogFile {
  /** 一条记录一行，不带换行。不等写盘：排着的超过上限、写盘失败时丢掉，记下条数 */
  write(line: string): void
  /** 换轮换的上限：份数调小了当场删掉多出来的旧文件，大小调小了，当前文件超出的下一批记录就轮换 */
  configure(limits: LogFileLimits): void
  /** 等排着的记录写完 */
  flush(): Promise<void>
  /** 写完排着的记录、关掉文件；之后的记录不再写 */
  close(): Promise<void>
}

const MB = 1024 * 1024
/** 写不进去、轮换失败的提示，每 10 分钟最多一次 */
const REPORT_INTERVAL = 10 * 60_000
/** 写不进去之后，过这么久才再试；这期间的记录直接丢掉、记下条数 */
const RETRY_DELAY = 1000
/** 一次写盘最少攒这么多：轮换失败、当前文件已经超出时，不至于一条一条地写 */
const MIN_BATCH = 64 * 1024
/** Windows 上文件被别的进程（杀毒软件、正在读日志的编辑器）占着时改名会失败，照 ADR-0061 重试几次 */
const RETRYABLE = ['EPERM', 'EBUSY', 'EACCES']
const ROTATED = /^nextskin\.(\d+)\.log$/

/**
 * 写日志文件并按大小轮换（ADR-0062）。一个数据目录同时只有一个写入方（启动器，或者不经过启动器时的核心），
 * 所以轮换不需要跨进程协调。写盘是异步的，不拖住调用方
 */
export function openLogFile(options: LogFileOptions): LogFile {
  const fs = options.fs ?? nodeFileSystem
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxPending = options.maxPending ?? 4 * MB
  const path = (name: string) => join(options.directory, name)
  let limits: LogFileLimits = options.limits ?? DEFAULT_LOG_FILE_LIMITS
  // 没给上限时，第一次写盘之前读 limits.json；configure 先到就不读了
  let loadLimits = !options.limits
  const lines: string[] = []
  const sizes: number[] = []
  let pending = 0
  let dropped = 0
  let retryAt = -Infinity
  let reportedAt = -Infinity
  let handle: LogFileHandle | undefined
  let written = 0
  // 写到一半失败时文件末尾可能是半行：下一次写之前先补一个换行，后面的记录不和它粘在一起
  let brokenTail = false
  let prune = false
  let persist = false
  let closed = false
  let running: Promise<void> | undefined

  const maxBytes = () => limits.maxFileSizeMb * MB

  const report = (msg: string, error: unknown) => {
    if (now() - reportedAt < REPORT_INTERVAL) return
    reportedAt = now()
    options.report.warn(msg, { file: path(LOG_FILE), code: errorCode(error) })
  }

  const kick = () => {
    if (running) return
    running = drain().then(() => {
      running = undefined
      if (lines.length > 0 || prune || persist) kick()
    })
  }

  const take = (limit: number) => {
    let bytes = 0
    let count = 0
    while (count < lines.length && (count === 0 || bytes + sizes[count]! <= limit)) bytes += sizes[count++]!
    pending -= bytes
    sizes.splice(0, count)
    return lines.splice(0, count)
  }

  const openCurrent = async () => {
    if (loadLimits) {
      loadLimits = false
      try {
        const saved: unknown = JSON.parse(await fs.readFile(path(LOG_LIMITS_FILE), 'utf8'))
        if (isLogFileLimits(saved)) limits = { maxFileSizeMb: saved.maxFileSizeMb, maxFiles: saved.maxFiles }
      } catch {
        // 没有、读不了、格式不对：用默认值
      }
    }
    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 })
    const opened = await fs.open(path(LOG_FILE), 'a', 0o600)
    try {
      written = (await opened.stat()).size
    } catch (error) {
      await opened.close().catch(() => undefined)
      throw error
    }
    handle = opened
    // mode 只管新建的：已有的目录、文件（从备份恢复的、旧版本建的）也收紧成只有运行服务的用户能读（Windows 上不起作用）
    await fs.chmod(options.directory, 0o700).catch(() => undefined)
    await fs.chmod(path(LOG_FILE), 0o600).catch(() => undefined)
  }

  const closeCurrent = async () => {
    const current = handle
    handle = undefined
    await current?.close().catch(() => undefined)
  }

  const move = async (from: string, to: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(path(from), path(to))
        return
      } catch (error) {
        if (attempt >= 4 || !RETRYABLE.includes(errorCode(error) ?? '')) throw error
        await sleep((attempt + 1) * 50)
      }
    }
  }

  // 旧文件依次后移，当前文件改名为 nextskin.1.log。上一次轮换中途失败时，序列里有个空位：只把空位前面的往后挪，
  // 不删文件；没有空位（份数满了）才删最旧的一份。改名失败就接着写当前文件，下一批再试
  const rotate = async () => {
    await closeCurrent()
    const keep = limits.maxFiles - 1
    try {
      const existing = new Set(await fs.readdir(options.directory))
      let gap = 1
      while (gap <= keep && existing.has(rotatedLogFile(gap))) gap++
      if (gap > keep) {
        await fs.rm(path(rotatedLogFile(keep)), { force: true })
        gap = keep
      }
      for (let index = gap - 1; index >= 1; index--) await move(rotatedLogFile(index), rotatedLogFile(index + 1))
      await move(LOG_FILE, rotatedLogFile(1))
    } catch (error) {
      report('日志文件轮换失败，接着写当前的文件', error)
    }
    await openCurrent()
  }

  const removeExtra = async () => {
    let names: string[]
    try {
      names = await fs.readdir(options.directory)
    } catch {
      return
    }
    for (const name of names) {
      const index = ROTATED.exec(name)?.[1]
      if (index && Number(index) >= limits.maxFiles) await fs.rm(path(name), { force: true }).catch(() => undefined)
    }
  }

  const drain = async () => {
    while (lines.length > 0 || prune || persist) {
      if (persist) {
        persist = false
        await fs.mkdir(options.directory, { recursive: true, mode: 0o700 }).catch(() => undefined)
        await fs.writeFile(path(LOG_LIMITS_FILE), `${JSON.stringify(limits)}\n`, { mode: 0o600 }).catch(() => undefined)
        continue
      }
      if (prune) {
        prune = false
        await removeExtra()
        continue
      }
      let batch: string[] = []
      try {
        if (!handle) await openCurrent()
        if (written >= maxBytes()) await rotate()
        batch = take(Math.max(maxBytes() - written, MIN_BATCH))
        const text = `${brokenTail ? '\n' : ''}${batch.join('\n')}\n`
        brokenTail = true
        await handle!.appendFile(text)
        brokenTail = false
        written += Buffer.byteLength(text)
      } catch (error) {
        // 磁盘满、没有权限：这一批和排着的都丢掉，过一会儿重新打开再试
        dropped += batch.length + lines.length
        lines.length = 0
        sizes.length = 0
        pending = 0
        await closeCurrent()
        retryAt = now() + RETRY_DELAY
        report('日志文件写不进去，先丢掉新的记录', error)
        continue
      }
      // 补一条丢了多少：排着的还很满时先不补，否则这一条也会被丢掉，计数跟着丢了
      if (dropped > 0 && pending < maxPending / 2) {
        const count = dropped
        dropped = 0
        options.report.warn('有记录没写进日志文件', { file: path(LOG_FILE), dropped: count })
      }
    }
  }

  return {
    write(line) {
      if (closed) return
      const bytes = Buffer.byteLength(line) + 1
      if (now() < retryAt || pending + bytes > maxPending) {
        dropped++
        return
      }
      lines.push(line)
      sizes.push(bytes)
      pending += bytes
      kick()
    },
    configure(next) {
      if (closed) return
      const fewer = next.maxFiles < limits.maxFiles
      const changed =
        loadLimits || fewer || next.maxFileSizeMb !== limits.maxFileSizeMb || next.maxFiles !== limits.maxFiles
      loadLimits = false
      limits = { maxFileSizeMb: next.maxFileSizeMb, maxFiles: next.maxFiles }
      if (!changed) return
      persist = true
      if (fewer) prune = true
      kick()
    },
    async flush() {
      while (running) await running
    },
    async close() {
      while (running) await running
      closed = true
      await closeCurrent()
    },
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}
