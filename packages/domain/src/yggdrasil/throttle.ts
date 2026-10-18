import { forbidden, YggdrasilError } from './errors.ts'

const WINDOW_MS = 15 * 60_000

export function createLoginThrottle(now: () => Date) {
  const intervals = new Map<string, number>()
  const failures = new Map<string, { startedAt: number; count: number }>()

  function prune(intervalMs: number) {
    const time = now().getTime()
    for (const [key, last] of intervals) if (time - last >= intervalMs) intervals.delete(key)
    for (const [key, value] of failures) if (time - value.startedAt >= WINDOW_MS) failures.delete(key)
    return time
  }

  return {
    interval(username: string | null, intervalMs: number) {
      const time = prune(intervalMs)
      const key = (username ?? '').trim().toLowerCase()
      const last = intervals.get(key)
      if (last !== undefined && time - last < intervalMs)
        throw new YggdrasilError('ForbiddenOperationException', 'yggdrasil.errors.too_frequent', null, {
          seconds: Math.ceil((intervalMs - (time - last)) / 1000),
        })
      if (intervalMs > 0) intervals.set(key, time)
    },
    assertAllowed(key: string, locale: string | null) {
      prune(600_000)
      if ((failures.get(key)?.count ?? 0) >= 5) throw forbidden('too_many_failures', locale)
    },
    fail(key: string) {
      const time = prune(600_000)
      const window = failures.get(key) ?? { startedAt: time, count: 0 }
      window.count++
      failures.set(key, window)
    },
  }
}
