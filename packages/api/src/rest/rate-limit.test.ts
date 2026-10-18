import { expect, test, vi } from 'vitest'
import { createMemoryRateLimiter } from './rate-limit.ts'

test('固定窗口按用户计数，Retry-After 向上取整，到期可重新尝试', () => {
  let now = 0
  const limiter = createMemoryRateLimiter(() => now)
  for (let i = 0; i < 3; i++) expect(limiter.consume('42').allowed).toBe(true)
  expect(limiter.consume('42')).toEqual({ allowed: false, retryAfter: 10 })
  now = 1001
  expect(limiter.consume('42')).toEqual({ allowed: false, retryAfter: 9 })
  expect(limiter.consume('43').allowed).toBe(true)
  now = 10_000
  expect(limiter.consume('42').allowed).toBe(true)
  for (let i = 0; i < 3; i++) expect(limiter.consume('43').allowed).toBe(i < 2)
})

test('请求其他 uid 时也会回收过期条目，尚未过期的计数保留', () => {
  let now = 0
  const limiter = createMemoryRateLimiter(() => now)
  limiter.consume('expired')
  now = 1000
  for (let i = 0; i < 3; i++) limiter.consume('active')
  now = 10_000
  const remove = vi.spyOn(Map.prototype, 'delete')
  try {
    limiter.consume('new-user')
    expect(remove).toHaveBeenCalledWith('expired')
    expect(remove).not.toHaveBeenCalledWith('active')
  } finally {
    remove.mockRestore()
  }
  expect(limiter.consume('active')).toEqual({ allowed: false, retryAfter: 1 })
  expect(limiter.consume('expired').allowed).toBe(true)
})
