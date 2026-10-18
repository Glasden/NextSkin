import { toIsoTimestamp } from '@nextskin/db'

export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** 按当地日期找第一毫秒，兼容夏令时导致的非 24 小时日；往前数的是日历日期。 */
export function todayStart(now: Date, timeZone: string, daysAgo = 0) {
  const date = new Date(`${localDate(now, timeZone)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - daysAgo)
  const target = date.toISOString().slice(0, 10)
  let lo = now.getTime() - (daysAgo + 2) * 86400000,
    hi = now.getTime()
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (localDate(new Date(mid), timeZone) < target) lo = mid + 1
    else hi = mid
  }
  return toIsoTimestamp(new Date(lo))
}
