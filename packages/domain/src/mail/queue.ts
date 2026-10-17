import type { MailMessage, MailTransport, QueuedMail } from './types.ts'

class MailTimeoutError extends Error {}

export interface MailQueueOptions {
  transport: MailTransport
  from: () => Promise<MailMessage['from']>
  concurrency?: number
  timeoutMs?: number
  attempts?: number
  retryDelayMs?: number
  log?: (type: 'timeout' | 'transport_error', attempt: number) => void
}

export function createMailQueue(options: MailQueueOptions) {
  const { concurrency = 2, timeoutMs = 30_000, attempts = 3, retryDelayMs = 1000 } = options
  if (
    ![concurrency, timeoutMs, attempts].every((n) => Number.isSafeInteger(n) && n > 0) ||
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 0
  )
    throw new RangeError('invalid mail queue options')
  const pending: QueuedMail[] = []
  let active = 0
  let sent = 0
  let failed = 0
  let discarded = 0
  const log = options.log ?? ((type, attempt) => console.warn(`[mail] ${type} attempt=${attempt}`))

  async function deliver(message: QueuedMail) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (async () => options.transport.send({ ...message, from: await options.from() }))(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new MailTimeoutError()), timeoutMs)
          }),
        ])
        sent++
        return
      } catch (error) {
        failed++
        // 只输出固定的类型和次数，连 Error.name 都可能是外部服务提供的敏感内容。
        try {
          log(error instanceof MailTimeoutError ? 'timeout' : 'transport_error', attempt)
        } catch {
          /* 日志失败不影响队列 */
        }
      } finally {
        clearTimeout(timer)
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt))
    }
    discarded++
  }

  function pump() {
    while (active < concurrency && pending.length) {
      active++
      void deliver(pending.shift()!).finally(() => {
        active--
        pump()
      })
    }
  }

  return {
    enqueue(message: QueuedMail): void {
      pending.push({ ...message })
      queueMicrotask(pump)
    },
    get stats(): Readonly<{ sent: number; failed: number; discarded: number }> {
      return Object.freeze({ sent, failed, discarded })
    },
  }
}
