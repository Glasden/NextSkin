import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMailQueue } from './queue.ts'
import type { MailTransport } from './types.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const message = { to: 'PRIVATE@example.test', subject: 'PRIVATE_SUBJECT', html: 'PRIVATE_BODY', text: 'PRIVATE_BODY' }
const from = () => Promise.resolve({ address: 'sender@example.test', name: 'Sender' })

test('立即返回、限制并发、失败退避重试、从当前设置填发件人、只读统计', async () => {
  let active = 0
  let peak = 0
  let calls = 0
  let sender = 'first@example.test'
  const seen: string[] = []
  const transport: MailTransport = {
    send: async (mail) => {
      active++
      peak = Math.max(peak, active)
      calls++
      seen.push(mail.from.address)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      if (calls <= 2) throw new Error('PRIVATE_PASSWORD')
      return { messageId: null }
    },
  }
  const log = vi.fn()
  const queue = createMailQueue({
    transport,
    from: () => Promise.resolve({ address: sender, name: '' }),
    retryDelayMs: 50,
    log,
  })
  for (let i = 0; i < 5; i++) expect(queue.enqueue(message)).toBeUndefined()
  expect(calls).toBe(0)
  await vi.advanceTimersByTimeAsync(20)
  sender = 'second@example.test'
  await vi.runAllTimersAsync()
  expect(peak).toBe(2)
  expect(queue.stats.sent).toBe(5)
  expect(queue.stats.failed).toBeGreaterThan(0)
  expect(seen).toContain('second@example.test')
  expect(Object.isFrozen(queue.stats)).toBe(true)
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE/)
})

test('每次尝试超时、最终丢弃；错误类型和日志不携带外部输入', async () => {
  const log = vi.fn()
  const send = vi.fn(() => new Promise<{ messageId: null }>(() => {}))
  const queue = createMailQueue({ transport: { send }, from, timeoutMs: 10, retryDelayMs: 5, attempts: 3, log })
  queue.enqueue(message)
  await vi.runAllTimersAsync()
  expect(send).toHaveBeenCalledTimes(3)
  expect(queue.stats).toEqual({ sent: 0, failed: 3, discarded: 1 })
  expect(log.mock.calls).toEqual([
    ['timeout', 1],
    ['timeout', 2],
    ['timeout', 3],
  ])
})

test('永久失败不会卡住后续邮件，默认日志只含固定类型与次数', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const queue = createMailQueue({
      transport: {
        send: () => Promise.reject(Object.assign(new Error('PRIVATE_BODY'), { name: 'PRIVATE_USERNAME' })),
      },
      from,
      attempts: 2,
      retryDelayMs: 1,
    })
    queue.enqueue(message)
    queue.enqueue(message)
    await vi.runAllTimersAsync()
    expect(queue.stats).toEqual({ sent: 0, failed: 4, discarded: 2 })
    expect(warn.mock.calls.flat().sort()).toEqual(
      Array.from({ length: 2 }, () => ['[mail] transport_error attempt=1', '[mail] transport_error attempt=2'])
        .flat()
        .sort(),
    )
  } finally {
    warn.mockRestore()
  }
})
