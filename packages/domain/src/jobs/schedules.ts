import { insertOrIgnore, toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import { Cron } from 'croner'
import type { Kysely } from 'kysely'
import type { JobHandler, JobRunner } from './runner.ts'

export interface ScheduleEntry {
  name: string
  cron: string
  job: string
  payload?: unknown
}

/** 只计算时间，不启动 croner 的定时器；日和星期按 Vixie cron 取或。 */
export function nextRunAt(cron: string, timeZone: string, from: Date): Date {
  const next = new Cron(cron, { timezone: timeZone, mode: '5-part', domAndDow: false }).nextRun(from)
  if (!next || next.getTime() <= from.getTime()) throw new RangeError('定时任务没有下一次执行时间')
  return next
}

export function createScheduler(options: {
  db: Kysely<CoreDatabase>
  jobs: Pick<JobRunner, 'enqueue'>
  handlers: ReadonlyMap<string, JobHandler>
  timeZone: () => Promise<string>
  now?: () => Date
  intervalMs?: number
  log?: (line: string) => void
}) {
  const { db, jobs, handlers, timeZone } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((line) => console.warn(line))
  const entries = new Map<string, ScheduleEntry>()
  let running = false
  let prune = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let checking: Promise<void> | undefined
  const failed = (error: unknown, name?: string) =>
    log(`[schedules] tick_failed${name ? ` ${name}` : ''} ${error instanceof Error ? error.name : typeof error}`)

  async function check() {
    try {
      const rows = await db.selectFrom('job_schedules').selectAll().execute()
      if (prune) {
        const names = rows
          .filter((row) => row.name.startsWith('core:') && !entries.has(row.name))
          .map((row) => row.name)
        if (names.length) await db.deleteFrom('job_schedules').where('name', 'in', names).execute()
        prune = false
      }
      const tz = await timeZone()
      const timestamp = now()
      for (const entry of entries.values()) {
        try {
          const row = rows.find((row) => row.name === entry.name)
          const next = () => toIsoTimestamp(nextRunAt(entry.cron, tz, timestamp))
          if (!row) {
            await insertOrIgnore(
              db,
              'job_schedules',
              {
                name: entry.name,
                cron: entry.cron,
                time_zone: tz,
                next_run_at: next(),
              },
              ['name'],
            )
            continue
          }
          // 两种写入都核验读到的三列，和其它实例的触发、重算互斥。
          const update = (tx: Kysely<CoreDatabase>) =>
            tx
              .updateTable('job_schedules')
              .where('name', '=', entry.name)
              .where('cron', '=', row.cron)
              .where('time_zone', '=', row.time_zone)
              .where('next_run_at', '=', row.next_run_at)
          if (row.cron !== entry.cron || row.time_zone !== tz) {
            await update(db).set({ cron: entry.cron, time_zone: tz, next_run_at: next() }).execute()
          } else if (Date.parse(row.next_run_at) <= timestamp.getTime()) {
            await transactionWithRetry(db, async (tx) => {
              const changed = await update(tx).set({ next_run_at: next() }).executeTakeFirstOrThrow()
              if (changed.numUpdatedRows === 1n)
                await jobs.enqueue(tx, entry.job, entry.payload ?? {}, { dedupeKey: entry.name })
            })
          }
        } catch (error) {
          failed(error, entry.name)
        }
      }
    } catch (error) {
      failed(error)
    }
  }
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => void tick(), options.intervalMs ?? 30_000)
    timer.unref()
  }
  function tick(): Promise<void> {
    if (checking) return checking
    checking = check().finally(() => {
      checking = undefined
      if (running) schedule()
    })
    return checking
  }
  return {
    add(entry: ScheduleEntry): void {
      const length = [...entry.name].length
      if (length < 1 || length > 128 || entry.name !== entry.name.trim())
        throw new RangeError('定时任务名长度必须在 1 到 128 个字符之间，首尾不能有空白')
      if (entries.has(entry.name)) throw new Error('定时任务名重复')
      if (!handlers.has(entry.job)) throw new Error('没有注册任务处理函数')
      const cron = entry.cron.trim()
      if (cron.split(/\s+/).length !== 5) throw new RangeError('定时任务必须是五段 cron 表达式')
      nextRunAt(cron, 'UTC', now())
      entries.set(entry.name, { ...entry, cron })
    },
    /** 插件停用时去掉它的条目；`job_schedules` 里的行留着，重新启用后接着按原来的时间算 */
    remove(name: string): void {
      entries.delete(name)
    },
    start(): void {
      if (running) return
      running = true
      prune = true
      void tick()
    },
    async stop(): Promise<void> {
      running = false
      clearTimeout(timer)
      await checking
    },
    tick,
  }
}
