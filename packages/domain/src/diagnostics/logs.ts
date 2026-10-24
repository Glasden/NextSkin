import { createHash } from 'node:crypto'
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LOG_DIRECTORY,
  LOG_FILE,
  LOG_LEVEL_VALUES,
  parseLogRecord,
  rotatedLogFile,
  type LogLevel,
  type LogRecord,
} from '@nextskin/logging'
import { z } from 'zod'
import { DomainError } from '../errors.ts'

export const LOG_SCAN_BYTES = 8 * 1024 * 1024
export const LOG_LINE_BYTES = 16 * 1024
export const EXPORT_LOG_BYTES = 10 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

export interface DiagnosticsLogQuery {
  level?: LogLevel
  source?: string
  text?: string
  cursor?: string
  limit?: number
}
export interface DiagnosticsLogEntry {
  id: string
  line: string
  record: LogRecord | null
}
export interface DiagnosticsLogPage {
  available: boolean
  entries: DiagnosticsLogEntry[]
  next: string | null
  scanLimited: boolean
}
interface LogFile {
  index: number
  name: string
  path: string
  size: number
  fingerprint: string
}
const fingerprint = (info: Awaited<ReturnType<typeof lstat>>) =>
  createHash('sha256').update(`${info.dev}:${info.ino}:${info.birthtimeMs}`).digest('hex')

/**
 * 只沿连续编号查找，limits.json 及断号后面的文件不参与翻页。符号链接不跟：日志文件都是启动器或核心自己建的，
 * 链接到别处的只会让页面和诊断包读到日志目录以外的文件
 */
export async function logFiles(dataDirectory: string): Promise<LogFile[]> {
  const files: LogFile[] = []
  for (let index = 0; ; index++) {
    const name = index === 0 ? LOG_FILE : rotatedLogFile(index)
    const path = join(dataDirectory, LOG_DIRECTORY, name)
    try {
      const info = await lstat(path)
      if (!info.isFile()) break
      files.push({ index, name, path, size: info.size, fingerprint: fingerprint(info) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  return files
}

/** 空间统计也计入轮换失败后断号的日志；不读 limits.json。 */
export async function logStorage(dataDirectory: string) {
  const directory = join(dataDirectory, LOG_DIRECTORY)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { logBytes: 0, logFiles: 0 }
    throw error
  }
  let logBytes = 0,
    logFiles = 0
  for (const name of names.filter((name) => /^nextskin(?:\.\d+)?\.log$/u.test(name))) {
    try {
      const info = await lstat(join(directory, name))
      if (info.isFile()) {
        logBytes += info.size
        logFiles++
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { logBytes, logFiles }
}

// carry 仅在 8 MB 边界落在一行中间时携带：保留前 16 KB 和关键字匹配状态，巨行也不会无限积压。
const carrySchema = z
  .object({
    head: z
      .string()
      .max(Math.ceil(LOG_LINE_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    matched: z.boolean(),
    discard: z.boolean(),
  })
  .strict()
const cursorSchema = z
  .object({
    v: z.literal(1),
    index: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    carry: carrySchema,
    // 筛选条件绑定在游标上，避免半行续扫沿用别的关键字的匹配结果。
    filter: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
type Cursor = z.infer<typeof cursorSchema>
const SHRUNK_FIELDS = 50
const SHRUNK_VALUE = 1000
const REQUIRED_FIELDS = new Set(['time', 'level', 'source', 'msg'])

/** 超过 16 KB 的行：固定字段都留着，其余最多 50 个，长的值截到 1000 个字符，页面照样显示时间、级别和来源 */
function shrink(record: LogRecord): LogRecord {
  let extra = 0
  const entries = Object.entries(record).filter(([key]) => REQUIRED_FIELDS.has(key) || extra++ < SHRUNK_FIELDS)
  return Object.fromEntries(
    entries.map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return [key, text.length > SHRUNK_VALUE ? `${text.slice(0, SHRUNK_VALUE)}…` : value]
    }),
  ) as LogRecord
}

const freshCarry = () => ({ head: '', bytes: 0, matched: false, discard: true })
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url')
function decode(raw: string): Cursor {
  try {
    if (raw.length > 40_000 || !/^[\w-]+$/u.test(raw)) throw new Error()
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
  } catch {
    throw new DomainError('invalid_request', undefined, ['cursor'])
  }
}
async function openSnapshot(file: LogFile): Promise<FileHandle | null> {
  let handle: FileHandle
  try {
    handle = await open(file.path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let matched = false
  try {
    matched = fingerprint(await handle.stat()) === file.fingerprint
    return matched ? handle : null
  } finally {
    if (!matched) await handle.close()
  }
}

export async function readLogs(
  dataDirectory: string,
  query: DiagnosticsLogQuery = {},
  visit?: (entry: DiagnosticsLogEntry) => void,
): Promise<DiagnosticsLogPage> {
  const limit = query.limit ?? 200
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    (query.text?.length ?? 0) > 1024 ||
    (query.source?.length ?? 0) > 256 ||
    (query.level !== undefined && !Object.hasOwn(LOG_LEVEL_VALUES, query.level))
  )
    throw new DomainError('invalid_request')
  const filter = createHash('sha256')
    .update(JSON.stringify([query.level ?? null, query.source ?? null, query.text ?? null]))
    .digest('hex')
  const cursor = query.cursor === undefined ? null : decode(query.cursor)
  if (cursor && cursor.filter !== filter) throw new DomainError('invalid_request', undefined, ['cursor'])
  const files = await logFiles(dataDirectory)
  const page: DiagnosticsLogPage = { available: files.length > 0, entries: [], next: null, scanLimited: false }
  let fileIndex = cursor
    ? files.findIndex((file) => file.index === cursor.index && file.fingerprint === cursor.fingerprint)
    : 0
  if (cursor && fileIndex < 0) fileIndex = files.findIndex((file) => file.fingerprint === cursor.fingerprint)
  if (fileIndex < 0) return page
  let budget = LOG_SCAN_BYTES
  let carry = cursor?.carry ?? freshCarry()
  let offset = cursor?.offset ?? files[fileIndex]?.size ?? 0
  const needle = query.text?.toLowerCase() ?? ''
  let head = Buffer.from(carry.head, 'base64')
  let fragments: Buffer[] | null = carry.bytes ? null : []
  let lineEnd = offset
  let completedLines = 0
  const save = (file: LogFile) =>
    encode({
      v: 1,
      index: file.index,
      fingerprint: file.fingerprint,
      offset,
      carry: { ...carry, head: head.toString('base64') },
      filter,
    })
  const add = (part: Buffer) => {
    if (carry.discard) return
    const joined = Buffer.concat([part, head])
    if (needle && joined.toString('utf8').toLowerCase().includes(needle)) carry.matched = true
    fragments?.push(part)
    carry.bytes += part.length
    head = joined.subarray(0, LOG_LINE_BYTES)
  }
  const finish = (file: LogFile, start: number) => {
    if (!carry.discard) {
      const raw = head.toString('utf8').replace(/\r$/u, '')
      const original = fragments ? Buffer.concat(fragments.toReversed()).toString('utf8').replace(/\r$/u, '') : raw
      const record = parseLogRecord(original)
      completedLines++
      if (
        (!query.level || LOG_LEVEL_VALUES[record?.level ?? 'info'] >= LOG_LEVEL_VALUES[query.level]) &&
        (query.source === undefined || record?.source === query.source) &&
        (!needle || carry.matched)
      ) {
        // 筛选用完整的记录；超过 16 KB 的行发给页面的是缩短的记录
        const truncated = carry.bytes > LOG_LINE_BYTES
        const entry = {
          id: `${file.fingerprint}:${start}`,
          line: raw + (truncated ? '…' : ''),
          record: truncated && record ? shrink(record) : record,
        }
        if (visit) visit(entry)
        else page.entries.push(entry)
      }
    }
    carry = { ...freshCarry(), discard: false }
    head = Buffer.alloc(0)
    fragments = []
  }
  for (; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex]!
    // 当前文件一直追加；本请求只读列目录时看到的大小。被截短的游标视为已经过期。
    if (offset > file.size) return page
    const handle = await openSnapshot(file)
    if (!handle) {
      // 列出文件之后、打开之前正好轮换了：游标照样指向这个文件，下一次按指纹在新的编号里找到它
      page.next = save(file)
      return page
    }
    try {
      while (offset > 0 && budget > 0) {
        const length = Math.min(CHUNK_BYTES, offset, budget)
        const start = offset - length
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, start)
        budget -= length
        if (bytesRead !== length) return page
        let end = length
        for (let newline = buffer.lastIndexOf(10, end - 1); newline >= 0; newline = buffer.lastIndexOf(10, end - 1)) {
          add(buffer.subarray(newline + 1, end))
          finish(file, start + newline + 1)
          offset = start + newline
          lineEnd = offset
          end = newline
          if (page.entries.length >= limit) {
            // 未处理的字节虽然已预读，游标仍指向它们；不跳过任何行。
            page.next = save(file)
            return page
          }
          if (end === 0) break
        }
        add(buffer.subarray(0, end))
        offset = start
      }
      if (offset === 0) finish(file, 0)
      if (offset > 0) {
        // 本页在一行中间耗尽预算时，让下一页从该行的末尾重读，以便解析完整 JSON。
        // 单独一行就超过 8 MB 时保留有界的 carry，继续向前走，不会原地重读。
        if (completedLines && !carry.discard) {
          offset = lineEnd
          carry = { ...freshCarry(), discard: false }
          head = Buffer.alloc(0)
        }
        page.next = save(file)
        page.scanLimited = true
        return page
      }
    } finally {
      await handle.close()
    }
    const older = files[fileIndex + 1]
    if (!older) break
    offset = older.size
    lineEnd = offset
    carry = freshCarry()
    fragments = []
    head = Buffer.alloc(0)
    if (budget === 0 || page.entries.length >= limit) {
      page.next = save(older)
      page.scanLimited = budget === 0 && page.entries.length < limit
      return page
    }
  }
  return page
}

/** 最新文件优先，最旧一份只取结尾；截断处跳过不完整的首行和末行。 */
export async function exportLogs(dataDirectory: string): Promise<{ name: string; bytes: Buffer }[]> {
  const result: { name: string; bytes: Buffer }[] = []
  let budget = EXPORT_LOG_BYTES
  for (const file of await logFiles(dataDirectory)) {
    if (!budget) break
    const handle = await openSnapshot(file)
    if (!handle) continue
    try {
      const length = Math.min(file.size, budget)
      const start = file.size - length
      const bytes = Buffer.alloc(length)
      const { bytesRead } = await handle.read(bytes, 0, length, start)
      budget -= length
      const end = bytes.lastIndexOf(10, bytesRead - 1) + 1
      // start > 0 时即使恰巧在行首，也保守跳过这一行，确保不导出半行。
      const begin = start > 0 ? bytes.indexOf(10) + 1 : 0
      if (end > begin) result.push({ name: file.name, bytes: bytes.subarray(begin, end) })
    } finally {
      await handle.close()
    }
  }
  return result
}
