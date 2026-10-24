import type { Core } from '@nextskin/domain'
import { afterEach, expect, test, vi } from 'vitest'
import { watchLogLimits } from './logging'

afterEach(() => {
  vi.useRealTimers()
})

test('核心打开后读一次轮换的上限，之后每分钟读一次，变了才交出去；没打开、读失败时跳过', async () => {
  vi.useFakeTimers()
  let values: Record<string, number> | Error = { 'logging.maxFileSizeMb': 10, 'logging.maxFiles': 5 }
  const read = vi.fn(() => (values instanceof Error ? Promise.reject(values) : Promise.resolve(values)))
  const server = { core: { settings: { read } } as unknown as Pick<Core, 'settings'> }
  let opened: Promise<typeof server> | undefined = Promise.resolve(server)
  const apply = vi.fn()
  const stop = watchLogLimits(() => opened, apply)
  await vi.waitFor(() => expect(apply).toHaveBeenCalledWith({ maxFileSizeMb: 10, maxFiles: 5 }))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(read).toHaveBeenCalledTimes(2)
  expect(apply).toHaveBeenCalledOnce()
  values = new Error('database is locked')
  await vi.advanceTimersByTimeAsync(60_000)
  opened = undefined
  await vi.advanceTimersByTimeAsync(60_000)
  expect(read).toHaveBeenCalledTimes(3)
  opened = Promise.resolve(server)
  values = { 'logging.maxFileSizeMb': 20, 'logging.maxFiles': 3 }
  await vi.advanceTimersByTimeAsync(60_000)
  expect(apply).toHaveBeenLastCalledWith({ maxFileSizeMb: 20, maxFiles: 3 })
  expect(apply).toHaveBeenCalledTimes(2)
  stop()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(read).toHaveBeenCalledTimes(4)
})
