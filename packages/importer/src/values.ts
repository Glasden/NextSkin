// 旧库读出来的值：同一列在 MySQL、PostgreSQL、SQLite 上的 JS 类型不同（数字可能是字符串，布尔可能是 0/1 或
// true/false，bigint 是字符串），这里统一转换。时间是 BS 按旧站时区写进去的本地时间（ADR-0015）
import { toIsoTimestamp, type IsoTimestamp } from '@nextskin/db'

export function toInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'bigint')
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : null
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : null
  }
  return null
}

export function toText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

/** tinyint、boolean 列：PostgreSQL 读出 true/false，另外两种读出 0/1 */
export function toFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const number = toInt(value)
  return number !== null && number !== 0
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** 时区在 utc 这一刻相对 UTC 的偏移（毫秒），东八区是 +8 小时 */
function zoneOffset(utc: number, timeZone: string): number {
  const parts: Record<string, number> = {}
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(utc)))
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  const local = Date.UTC(parts.year!, parts.month! - 1, parts.day, parts.hour, parts.minute, parts.second)
  return local - (utc - (((utc % 1000) + 1000) % 1000))
}

export function isTimeZone(timeZone: string): boolean {
  try {
    zoneFormatter(timeZone)
    return true
  } catch {
    return false
  }
}

const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/

/**
 * 旧库的 datetime、timestamp 读成 UTC 的 ISO 时间。没有时区后缀的按旧站时区解释；夏令时切换时重复的时刻取较早的一个。
 * MySQL 的零日期（`0000-00-00 00:00:00`）和其他不合法的值返回 null
 */
export function bsDateTime(value: unknown, timeZone: string): IsoTimestamp | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? toIsoTimestamp(value) : null
  if (typeof value !== 'string') return null
  const match = DATETIME.exec(value.trim())
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const millisecond = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3))
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  const check = new Date(local)
  // Date.UTC 会把 2 月 30 日这类值滚到下个月；零日期也在这里被拒绝
  if (
    year < 1 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null
  const suffix = match[8]
  let utc: number
  if (suffix === 'Z') utc = local
  else if (suffix) {
    const sign = suffix.startsWith('-') ? -1 : 1
    const digits = suffix.slice(1).replace(':', '')
    utc = local - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0)) * 60_000
  } else {
    const first = local - zoneOffset(local, timeZone)
    utc = local - zoneOffset(first, timeZone)
  }
  try {
    return toIsoTimestamp(new Date(utc))
  } catch {
    return null
  }
}
