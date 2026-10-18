import { toIsoTimestamp, type CoreDatabase, type IsoTimestamp } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { DomainError } from '../errors.ts'
import { claimJob, completeJob, failJob, findDueJobs, insertJob, rescheduleJob, type ClaimedJob } from './store.ts'

/** 一种任务的处理方式。处理函数在事务之外执行，至少执行一次，必须容忍重复（ADR-0021）。 */
export interface JobHandler {
  /** jobId 是本次认领的 jobs.id；续跑时用它释放自己的去重键，重试仍使用同一个 id。 */
  run(args: { jobId: number; payload: unknown; attempt: number; signal: AbortSignal }): Promise<void>
  /** 默认 5，与 SDK 的 JobDefinition 相同 */
  maxAttempts?: number
  /** 默认 60 秒；超时后 signal 被 abort，这次执行按失败处理 */
  timeoutMs?: number
  /** 这种任务同时执行的上限，默认只受执行器的全局上限限制 */
  concurrency?: number
  /** 进死信时替换载荷，去掉链接里的令牌这类敏感内容 */
  deadLetterPayload?(payload: unknown): unknown
}

export interface JobRunnerOptions {
  db: Kysely<CoreDatabase>
  handlers: ReadonlyMap<string, JobHandler>
  /** 全局并发上限，默认 4 */
  concurrency?: number
  /** 空闲时的轮询间隔，默认 1 秒 */
  pollIntervalMs?: number
  /** 停止时等待执行中任务的上限，默认 10 秒 */
  stopTimeoutMs?: number
  now?: () => Date
  random?: () => number
  log?: (line: string) => void
}

const LEASE_MARGIN_MS = 30_000
const BACKOFF_BASE_MS = 10_000
const BACKOFF_MAX_MS = 3_600_000

class JobTimeoutError extends Error {}

/** 第 attempt 次失败之后等多久再试：10 秒起指数增长，上限 1 小时，再乘上 0.8 到 1.2 的随机抖动 */
export function backoffMs(attempt: number, random: number): number {
  return Math.round(Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS) * (0.8 + 0.4 * random))
}

/**
 * 只记固定的错误码：外部服务和异常消息里可能带着收件地址、令牌（不变量 11）。
 * 插件任务的消息以后由插件运行时自己记录。
 */
function errorCode(error: unknown): string {
  if (error instanceof JobTimeoutError) return 'timeout'
  if (error instanceof DomainError) return error.code
  return 'error'
}

export function createJobRunner(options: JobRunnerOptions) {
  const { db, handlers } = options
  const concurrency = options.concurrency ?? 4
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const now = options.now ?? (() => new Date())
  const random = options.random ?? Math.random
  const log = options.log ?? ((line) => console.warn(line))
  const active = new Map<number, { name: string; done: Promise<void>; controller: AbortController }>()
  // execute 超时后可能已经结束，处理函数仍要单独跟踪到真正完成。
  const executions = new Set<Promise<void>>()
  let running = false
  // stop() 之后进行中的 poll 也不再认领；drain() 和执行器、和另一个 drain() 不能同时 poll，否则并发上限会被突破
  let stopping = false
  let draining = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let polling: Promise<number> | undefined
  let pollAgain = false

  const at = (offsetMs = 0): IsoTimestamp => toIsoTimestamp(new Date(now().getTime() + offsetMs))
  const saturated = (name: string) => {
    const limit = handlers.get(name)?.concurrency
    return limit !== undefined && [...active.values()].filter((job) => job.name === name).length >= limit
  }

  /** 认领并启动到期的任务，返回启动了几个。数据库出错时记一行日志，下个周期再来 */
  async function poll(): Promise<number> {
    let started = 0
    try {
      // 同一批里某种任务达到自己的并发上限、后面的行被跳过时，排除它再查一次，空出的槽位留给别的任务。
      // 最多补查任务种类数那么多轮，剩下的交给下个周期
      for (let round = 0, skipped = true; skipped && round <= handlers.size; round++) {
        skipped = false
        const free = concurrency - active.size
        if (free <= 0 || stopping) break
        const names = [...handlers.keys()].filter((name) => !saturated(name))
        const due = await findDueJobs(db, { names, now: at(), limit: free })
        for (const { id, name } of due) {
          if (active.size >= concurrency || stopping) break
          if (saturated(name)) {
            skipped = true
            continue
          }
          const handler = handlers.get(name)!
          const timeoutMs = handler.timeoutMs ?? 60_000
          const job = await claimJob(db, { id, now: at(), leaseUntil: at(timeoutMs + LEASE_MARGIN_MS) })
          if (!job) continue
          start(job, handler, timeoutMs)
          started++
        }
      }
    } catch (error) {
      log(`[jobs] poll_failed ${error instanceof Error ? error.name : typeof error}`)
    }
    return started
  }

  function start(job: ClaimedJob, handler: JobHandler, timeoutMs: number) {
    const controller = new AbortController()
    const done = execute(job, handler, timeoutMs, controller)
      .catch((error: unknown) =>
        log(`[jobs] settle_failed ${job.name} ${error instanceof Error ? error.name : 'error'}`),
      )
      .finally(() => {
        active.delete(job.id)
        // 腾出了槽位：有积压时不必等到下个轮询周期
        if (running) schedule(0)
      })
    active.set(job.id, { name: job.name, done, controller })
  }

  async function execute(job: ClaimedJob, handler: JobHandler, timeoutMs: number, controller: AbortController) {
    const lease = { id: job.id, leaseId: job.leaseId }
    const maxAttempts = handler.maxAttempts ?? 5
    // 上一次执行到一半进程退出了，那一次也算数；反复把进程搞崩的任务不再执行
    if (job.attempts > maxAttempts) {
      await failJob(db, lease, { error: 'attempts_exhausted', now: at(), payload: deadLetter(handler, job.payload) })
      return
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const execution = handler.run({
        jobId: job.id,
        payload: job.payload,
        attempt: job.attempts,
        signal: controller.signal,
      })
      executions.add(execution)
      const remove = () => {
        executions.delete(execution)
      }
      void execution.then(remove, remove)
      await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new JobTimeoutError())
          }, timeoutMs)
        }),
      ])
    } catch (error) {
      const code = errorCode(error)
      log(`[jobs] failed ${job.name} code=${code} attempt=${job.attempts}`)
      if (job.attempts >= maxAttempts)
        await failJob(db, lease, { error: code, now: at(), payload: deadLetter(handler, job.payload) })
      else await rescheduleJob(db, lease, { runAt: at(backoffMs(job.attempts, random())), error: code })
      return
    } finally {
      clearTimeout(timeout)
    }
    await completeJob(db, lease)
  }

  /** 脱敏函数出错时存 null：既不能让任务卡在 jobs 里反复重来，也不能退回去存原始载荷 */
  function deadLetter(handler: JobHandler, payload: unknown): unknown {
    if (!handler.deadLetterPayload) return payload
    try {
      return handler.deadLetterPayload(payload)
    } catch {
      return null
    }
  }

  /** 同一时间只有一轮 poll；轮询期间又被叫到，就在这一轮结束后马上再来一轮 */
  function schedule(delayMs: number) {
    clearTimeout(timer)
    timer = setTimeout(() => void tick(), delayMs)
    // 执行器自己不让进程常驻：服务端有 HTTP 服务器撑着，测试里忘了 stop 也不会卡住进程
    timer.unref()
  }

  async function tick() {
    if (polling) {
      pollAgain = true
      return
    }
    polling = poll()
    await polling
    polling = undefined
    if (!running) return
    if (pollAgain) {
      pollAgain = false
      schedule(0)
    } else schedule(pollIntervalMs)
  }

  async function stop(): Promise<void> {
    running = false
    stopping = true
    clearTimeout(timer)
    const settled = (async () => {
      await polling
      await Promise.all([...active.values()].map((job) => job.done))
    })()
    let waiting: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      settled.then(() => false),
      new Promise<boolean>((resolve) => {
        waiting = setTimeout(() => resolve(true), options.stopTimeoutMs ?? 10_000)
      }),
    ])
    clearTimeout(waiting)
    if (timedOut) for (const job of active.values()) job.controller.abort()
  }

  return {
    /** 入队：传事务就随业务写入一起提交（ADR-0021）。返回 false 表示同一去重键已有未完成的任务 */
    enqueue(
      executor: Kysely<CoreDatabase>,
      name: string,
      payload: unknown,
      options: { delayMs?: number; dedupeKey?: string } = {},
    ): Promise<boolean> {
      if (!handlers.has(name)) throw new Error(`没有注册任务处理函数 ${name}`)
      return insertJob(executor, { name, payload, runAt: at(options.delayMs), dedupeKey: options.dedupeKey }, at())
    },
    start(): void {
      if (draining) throw new Error('drain 还没结束，不能启动执行器')
      if (running) return
      running = true
      stopping = false
      schedule(0)
    },
    /**
     * 不再认领新任务，等进行中的 poll 和执行中的任务结束；超过上限就 abort 执行中的任务并返回，
     * 剩下的等租约到期后由下次启动接手
     */
    stop,
    /** stop 之后再等处理函数真正结束，导入不能与尚未结束的文件操作并行。 */
    async quiesce(timeoutMs: number): Promise<boolean> {
      await stop()
      const settled = (async () => {
        // stop 超时返回时，poll 和任务的收尾也可能还没有结束。
        await polling
        await Promise.all([...active.values()].map((job) => job.done))
        await Promise.allSettled([...executions])
      })()
      let waiting: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          settled.then(() => true),
          new Promise<boolean>((resolve) => {
            waiting = setTimeout(() => resolve(false), timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(waiting)
      }
    },
    /** 执行到没有到期的任务为止。测试和命令行用，不能和执行器或另一个 drain 同时进行 */
    async drain(): Promise<void> {
      if (running || draining) throw new Error('执行器正在运行或另一个 drain 还没结束，不能同时 drain')
      draining = true
      try {
        for (;;) {
          const started = await poll()
          // 启动的任务可能在 poll 返回之前就已经结束，这时再查一轮，不能去等一个空的 race
          if (active.size) await Promise.race([...active.values()].map((job) => job.done))
          else if (!started) return
        }
      } finally {
        draining = false
      }
    },
  }
}

export type JobRunner = ReturnType<typeof createJobRunner>
