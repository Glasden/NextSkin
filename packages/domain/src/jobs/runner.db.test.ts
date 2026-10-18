import { coreMigrations, migrateToLatest, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { DomainError } from '../errors.ts'
import { backoffMs, createJobRunner, type JobHandler, type JobRunnerOptions } from './runner.ts'
import { claimJob, findDueJobs, insertJob } from './store.ts'

vi.mock('./store.ts', { spy: true })
const store = await vi.importActual<typeof import('./store.ts')>('./store.ts')

let database: TestDatabase<CoreDatabase>
let clock: Date
const lines: string[] = []

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await database.db.deleteFrom('jobs').execute()
  await database.db.deleteFrom('failed_jobs').execute()
  clock = new Date('2030-01-01T00:00:00.000Z')
  lines.length = 0
})

const iso = (offsetMs = 0) => toIsoTimestamp(new Date(clock.getTime() + offsetMs))
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}

function runner(handlers: Record<string, JobHandler>, options: Partial<JobRunnerOptions> = {}) {
  return createJobRunner({
    db: database.db,
    handlers: new Map(Object.entries(handlers)),
    now: () => clock,
    random: () => 0.5,
    log: (line) => lines.push(line),
    ...options,
  })
}

const jobs = () => database.db.selectFrom('jobs').selectAll().orderBy('id').execute()
const failed = () => database.db.selectFrom('failed_jobs').selectAll().orderBy('id').execute()

test('执行到期的任务，成功后删除；未到期的和没有处理函数的任务不动', async () => {
  const seen: unknown[] = []
  const seenIds: number[] = []
  const r = runner({
    'core:test': {
      run: ({ jobId, payload, attempt }) => {
        seenIds.push(jobId)
        seen.push([payload, attempt])
        return Promise.resolve()
      },
    },
  })
  await r.enqueue(database.db, 'core:test', { n: 1 })
  await r.enqueue(database.db, 'core:test', { n: 2 }, { delayMs: 60_000 })
  const ids = (await jobs()).map((job) => job.id)
  await insertJob(database.db, { name: 'plugin:gone:job:x', payload: {}, runAt: iso() }, iso())
  await r.drain()
  expect(seen).toEqual([[{ n: 1 }, 1]])
  expect(seenIds).toEqual([ids[0]])
  expect((await jobs()).map((job) => job.name)).toEqual(['core:test', 'plugin:gone:job:x'])
  advance(60_000)
  await r.drain()
  expect(seen).toEqual([
    [{ n: 1 }, 1],
    [{ n: 2 }, 1],
  ])
  expect(seenIds).toEqual(ids)
  expect((await jobs()).map((job) => job.name)).toEqual(['plugin:gone:job:x'])
})

test('入队拒绝没有注册的任务名；去重键相同的未完成任务只入队一次', async () => {
  const r = runner({ 'core:test': { run: () => Promise.resolve() } })
  expect(() => r.enqueue(database.db, 'core:unknown', {})).toThrow('core:unknown')
  expect(await r.enqueue(database.db, 'core:test', {}, { dedupeKey: 'k' })).toBe(true)
  expect(await r.enqueue(database.db, 'core:test', {}, { dedupeKey: 'k' })).toBe(false)
  await r.drain()
  expect(await r.enqueue(database.db, 'core:test', {}, { dedupeKey: 'k' })).toBe(true)
})

test('失败按退避重试，只记固定的错误码；次数用完移进死信，载荷按处理函数替换', async () => {
  let calls = 0
  const r = runner({
    'core:flaky': {
      maxAttempts: 3,
      run: () => {
        calls++
        return Promise.reject(calls === 1 ? new DomainError('mail_not_configured') : new Error('SECRET_TOKEN_CANARY'))
      },
      deadLetterPayload: (payload) => ({ ...(payload as object), url: undefined, redacted: true }),
    },
  })
  await r.enqueue(database.db, 'core:flaky', { url: 'https://example.test/?token=SECRET_TOKEN_CANARY' })
  await r.drain()
  let [job] = await jobs()
  expect(job).toMatchObject({ attempts: 1, last_error: 'mail_not_configured', lease_id: null, run_at: iso(10_000) })

  advance(9_999)
  await r.drain()
  expect(calls).toBe(1)
  advance(1)
  await r.drain()
  ;[job] = await jobs()
  expect(job).toMatchObject({ attempts: 2, last_error: 'error', run_at: iso(backoffMs(2, 0.5)) })

  advance(backoffMs(2, 0.5))
  await r.drain()
  expect(calls).toBe(3)
  expect(await jobs()).toEqual([])
  const [dead] = await failed()
  expect(dead).toMatchObject({ name: 'core:flaky', attempts: 3, last_error: 'error', failed_at: iso() })
  expect(JSON.parse(dead!.payload)).toEqual({ redacted: true })
  expect(JSON.stringify([lines, await failed()])).not.toContain('SECRET_TOKEN_CANARY')
})

test('退避从 10 秒起指数增长，上限 1 小时，抖动在 ±20% 以内', () => {
  expect(backoffMs(1, 0.5)).toBe(10_000)
  expect(backoffMs(2, 0.5)).toBe(20_000)
  expect(backoffMs(20, 0.5)).toBe(3_600_000)
  expect(backoffMs(1, 0)).toBe(8_000)
  expect(backoffMs(1, 1)).toBe(12_000)
})

test('超时 abort 处理函数的 signal，这次按失败处理', async () => {
  let signal: AbortSignal | undefined
  const r = runner({
    'core:slow': {
      timeoutMs: 20,
      run: ({ signal: s }) => {
        signal = s
        return new Promise(() => {})
      },
    },
  })
  await r.enqueue(database.db, 'core:slow', {})
  await r.drain()
  expect(signal?.aborted).toBe(true)
  expect(await jobs()).toMatchObject([{ attempts: 1, last_error: 'timeout', lease_id: null }])
})

test('执行到一半进程退出：租约到期后重新认领，次数已经用完的直接进死信、不再执行', async () => {
  const run = vi.fn(() => Promise.resolve())
  const r = runner({ 'core:test': { maxAttempts: 1, timeoutMs: 1000, run } })
  await r.enqueue(database.db, 'core:test', {})
  const id = (await jobs())[0]!.id
  // 模拟另一个进程认领后崩溃：租约留在行上
  expect(await claimJob(database.db, { id, now: iso(), leaseUntil: iso(31_000) })).not.toBeNull()
  await r.drain()
  expect(run).not.toHaveBeenCalled()
  advance(31_000)
  await r.drain()
  expect(run).not.toHaveBeenCalled()
  expect(await jobs()).toEqual([])
  expect(await failed()).toMatchObject([{ attempts: 2, last_error: 'attempts_exhausted' }])
})

test('全局并发和每种任务的并发都有上限；某种任务满了，空出的槽位在同一轮里给别的任务', async () => {
  const active = { a: 0, b: 0 }
  const peak = { a: 0, b: 0, total: 0 }
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => (open = resolve))
  const handler = (key: 'a' | 'b', concurrency?: number): JobHandler => ({
    concurrency,
    run: async () => {
      active[key]++
      peak[key] = Math.max(peak[key], active[key])
      peak.total = Math.max(peak.total, active.a + active.b)
      await gate
      active[key]--
    },
  })
  const r = runner({ 'core:a': handler('a', 1), 'core:b': handler('b') }, { concurrency: 3 })
  // 按 a、b 交替入队：第一批取回 a、b、a，第二个 a 被跳过
  for (let i = 0; i < 4; i++) {
    await r.enqueue(database.db, 'core:a', {})
    await r.enqueue(database.db, 'core:b', {})
  }
  const draining = r.drain()
  await vi.waitFor(() => expect(active).toEqual({ a: 1, b: 2 }))
  open()
  await draining
  expect(await jobs()).toEqual([])
  expect(peak).toEqual({ a: 1, b: 2, total: 3 })
})

test('只有一种任务受并发限制、其余种类没有积压时，drain 也能执行完', async () => {
  let runs = 0
  const r = runner({
    'core:a': {
      concurrency: 1,
      run: () => {
        runs++
        return Promise.resolve()
      },
    },
    'core:b': { run: () => Promise.resolve() },
  })
  for (let i = 0; i < 3; i++) await r.enqueue(database.db, 'core:a', {})
  await r.drain()
  expect(runs).toBe(3)
  expect(await jobs()).toEqual([])
})

test('脱敏函数出错时死信载荷存 null，任务不会卡在队列里', async () => {
  const r = runner({
    'core:test': {
      maxAttempts: 1,
      run: () => Promise.reject(new Error('fail')),
      deadLetterPayload: () => {
        throw new Error('redact failed')
      },
    },
  })
  await r.enqueue(database.db, 'core:test', { secret: 'SECRET_TOKEN_CANARY' })
  await r.drain()
  expect(await jobs()).toEqual([])
  expect(await failed()).toMatchObject([{ payload: 'null', last_error: 'error' }])
})

test('drain 不能并行，也不能和执行器同时进行', async () => {
  const r = runner({ 'core:test': { run: () => new Promise((resolve) => setTimeout(resolve, 20)) } })
  await r.enqueue(database.db, 'core:test', {})
  const first = r.drain()
  await expect(r.drain()).rejects.toThrow()
  expect(() => r.start()).toThrow()
  await first
  expect(await jobs()).toEqual([])
})

test('stop 时进行中的 poll 不再认领；poll 卡住时 stop 也按时返回', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  let queried = false
  vi.mocked(findDueJobs).mockImplementationOnce(async (...args) => {
    await gate
    const due = await store.findDueJobs(...args)
    queried = true
    return due
  })
  const run = vi.fn(() => Promise.resolve())
  const r = runner({ 'core:test': { run } }, { pollIntervalMs: 10, stopTimeoutMs: 20, now: () => new Date() })
  await r.enqueue(database.db, 'core:test', {})
  r.start()
  await vi.waitFor(() => expect(findDueJobs).toHaveBeenCalled())
  await r.stop()
  release()
  await vi.waitFor(() => expect(queried).toBe(true))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(run).not.toHaveBeenCalled()
  expect(await jobs()).toMatchObject([{ attempts: 0, lease_id: null }])
})

test('start 之后按轮询执行新任务；stop 等执行中的任务结束，之后不再认领', async () => {
  let release: () => void = () => {}
  const started: number[] = []
  const r = runner(
    {
      'core:test': {
        run: async ({ payload }) => {
          started.push((payload as { n: number }).n)
          await new Promise<void>((resolve) => (release = resolve))
        },
      },
    },
    { pollIntervalMs: 10, now: () => new Date() },
  )
  r.start()
  await r.enqueue(database.db, 'core:test', { n: 1 })
  await vi.waitFor(() => expect(started).toEqual([1]))
  const stopping = r.stop()
  await r.enqueue(database.db, 'core:test', { n: 2 })
  release()
  await stopping
  expect(started).toEqual([1])
  expect((await jobs()).map((job) => JSON.parse(job.payload) as unknown)).toEqual([{ n: 2 }])
})

test('stop 等待超过上限就 abort 执行中的任务，任务留给下次启动', async () => {
  let signal: AbortSignal | undefined
  const r = runner(
    {
      'core:stuck': {
        run: ({ signal: s }) => {
          signal = s
          return new Promise(() => {})
        },
      },
    },
    { pollIntervalMs: 10, stopTimeoutMs: 20, now: () => new Date() },
  )
  r.start()
  await r.enqueue(database.db, 'core:stuck', {})
  await vi.waitFor(() => expect(signal).toBeDefined())
  await r.stop()
  expect(signal?.aborted).toBe(true)
  expect(await jobs()).toMatchObject([{ attempts: 1 }])
})

test('执行器运行时不能 drain', async () => {
  const r = runner({}, { pollIntervalMs: 10 })
  r.start()
  await expect(r.drain()).rejects.toThrow()
  await r.stop()
})
