export interface RateLimitResult {
  allowed: boolean
  retryAfter: number
}

/** 默认按 uid 在进程内计数；共享存储驱动可以异步消费（ADR-0002）。 */
export interface RateLimiter {
  consume(key: string): RateLimitResult | Promise<RateLimitResult>
}

export function createMemoryRateLimiter(
  now: () => number = Date.now,
  options: { limit?: number; windowMs?: number } = {},
) {
  const windows = new Map<string, { count: number; expiresAt: number }>()
  return {
    consume(key: string) {
      const time = now()
      // 不设后台定时器；每次请求回收过期用户，条目不会随历史用户数无限增长。
      for (const [uid, window] of windows) if (window.expiresAt <= time) windows.delete(uid)
      let window = windows.get(key)
      if (!window) {
        window = { count: 0, expiresAt: time + (options.windowMs ?? 10_000) }
        windows.set(key, window)
      }
      if (window.count >= (options.limit ?? 3))
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((window.expiresAt - time) / 1000)) }
      window.count++
      return { allowed: true, retryAfter: 0 }
    },
  } satisfies RateLimiter
}
