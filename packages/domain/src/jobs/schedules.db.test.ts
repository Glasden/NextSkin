import { coreMigrations, migrateToLatest, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createJobRunner, type JobHandler } from './runner.ts'
import { createScheduler, nextRunAt } from './schedules.ts'

let database: TestDatabase<CoreDatabase>
let clock: Date
let zone: string
const lines: string[] = []
const name = 'core:test'
const handlers = new Map<string, JobHandler>([[name, { run: async () => {} }]])
const db = () => database.db
const now = () => clock
const iso = (date: string) => toIsoTimestamp(new Date(date))
const queue = () => db().selectFrom('jobs').selectAll().execute()
const row = () => db().selectFrom('job_schedules').selectAll().where('name', '=', name).executeTakeFirstOrThrow()
function scheduler(cron = '0 0 * * *', jobs = createJobRunner({ db: db(), handlers, now })) {
  const schedules = createScheduler({
    db: db(),
    jobs,
    handlers,
    now,
    timeZone: () => Promise.resolve(zone),
    log: (line) => lines.push(line),
    intervalMs: 10,
  })
  schedules.add({ name, job: name, cron, payload: { test: true } })
  return schedules
}
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db().deleteFrom('jobs').execute()
  await db().deleteFrom('job_schedules').execute()
  clock = new Date('2030-01-01T00:00:00Z')
  zone = 'UTC'
  lines.length = 0
})

test('缺行只插入；到期入队一次，并从现在计算下次时间', async () => {
  const s = scheduler()
  await s.tick()
  expect(await row()).toMatchObject({ cron: '0 0 * * *', time_zone: 'UTC', next_run_at: iso('2030-01-02') })
  expect(await queue()).toEqual([])
  clock = new Date('2030-01-02T00:00:00Z')
  await s.tick()
  await s.tick()
  expect(await queue()).toMatchObject([{ name, dedupe_key: name, payload: '{"test":true}' }])
  expect((await row()).next_run_at).toBe(iso('2030-01-03'))
})

test('两个实例同时认领到期条目，只入队一次', async () => {
  const jobs = createJobRunner({ db: db(), handlers, now })
  const enqueue = vi.spyOn(jobs, 'enqueue')
  const a = scheduler('0 0 * * *', jobs),
    b = scheduler('0 0 * * *', jobs)
  await a.tick()
  clock = new Date('2030-01-02')
  await Promise.all([a.tick(), b.tick()])
  expect(enqueue).toHaveBeenCalledTimes(1)
  expect(await queue()).toHaveLength(1)
  expect((await row()).next_run_at).toBe(iso('2030-01-03'))
  expect(lines).toEqual([])
})

test('停机错过三次只补一次；已有同名去重任务时跳过但继续推进', async () => {
  const s = scheduler()
  await s.tick()
  clock = new Date('2030-01-04T12:00:00Z')
  await s.tick()
  expect(await queue()).toHaveLength(1)
  expect((await row()).next_run_at).toBe(iso('2030-01-05'))
  clock = new Date('2030-01-05')
  await s.tick()
  expect(await queue()).toHaveLength(1)
  expect((await row()).next_run_at).toBe(iso('2030-01-06'))
})

test('改时区和表达式即使已到期也只重算，本实例未注册的条目不动', async () => {
  const a = scheduler()
  await a.tick()
  clock = new Date('2030-01-03')
  zone = 'Asia/Shanghai'
  await a.tick()
  expect(await row()).toMatchObject({ time_zone: zone, next_run_at: iso('2030-01-03T16:00:00Z') })
  const b = scheduler('0 4 * * *')
  await b.tick()
  expect(await row()).toMatchObject({ cron: '0 4 * * *', next_run_at: iso('2030-01-03T20:00:00Z') })
  expect(await queue()).toEqual([])
})

test('启动删除废弃核心条目，保留其他前缀及当前条目；停止后不再轮询', async () => {
  await db()
    .insertInto('job_schedules')
    .values(
      ['core:gone', 'plugin:gone', 'CORE:keep', 'CoRe:keep'].map((name) => ({
        name,
        cron: '0 0 * * *',
        time_zone: 'UTC',
        next_run_at: iso('2020-01-01'),
      })),
    )
    .execute()
  const s = scheduler()
  s.start()
  try {
    // 在 JS 里排序：PG 按区域设置的排序规则比较大小写，ORDER BY 的结果和另外三种数据库不同
    await vi.waitFor(async () =>
      expect((await db().selectFrom('job_schedules').select('name').execute()).map((row) => row.name).sort()).toEqual(
        ['CORE:keep', 'CoRe:keep', name, 'plugin:gone'].sort(),
      ),
    )
    await s.stop()
    clock = new Date('2030-01-02')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await queue()).toEqual([])
  } finally {
    await s.stop()
  }
})

test('手动检查和定时检查不并发，停止等待正在进行的一轮', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const timeZone = vi.fn(async () => {
    await gate
    return 'UTC'
  })
  const s = createScheduler({ db: db(), jobs: createJobRunner({ db: db(), handlers, now }), handlers, now, timeZone })
  s.add({ name, job: name, cron: '0 0 * * *' })
  s.start()
  await vi.waitFor(() => expect(timeZone).toHaveBeenCalledTimes(1))
  const tick = s.tick()
  let stopped = false
  const stop = s.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  release()
  await Promise.all([tick, stop])
  expect(timeZone).toHaveBeenCalledTimes(1)
})

test('单个条目入队失败回滚且不影响其它条目，下轮重试；日志不含异常消息', async () => {
  const jobs = createJobRunner({ db: db(), handlers, now })
  const enqueue = vi
    .fn((...args: Parameters<typeof jobs.enqueue>) => jobs.enqueue(...args))
    .mockRejectedValueOnce(new TypeError('SECRET_CANARY'))
  const s = createScheduler({
    db: db(),
    jobs: { enqueue },
    handlers,
    now,
    timeZone: () => Promise.resolve(zone),
    log: (line) => lines.push(line),
  })
  s.add({ name, job: name, cron: '* * * * *' })
  s.add({ name: 'core:other', job: name, cron: '* * * * *' })
  await s.tick()
  clock = new Date('2030-01-01T00:01:00Z')
  await s.tick()
  expect(await queue()).toHaveLength(1)
  expect(lines).toEqual(['[schedules] tick_failed core:test TypeError'])
  expect((await row()).next_run_at).toBe(iso('2030-01-01T00:01:00Z'))
  await s.tick()
  expect(await queue()).toHaveLength(2)
  zone = 'SECRET_CANARY'
  clock = new Date('2030-01-01T00:02:00Z')
  await s.tick()
  expect(lines.join()).not.toContain('SECRET_CANARY')
})

test('注册校验名字、重复、处理函数、五段语法及不存在的日期', () => {
  const s = scheduler()
  for (const invalid of ['', ' a', 'a ', 'x'.repeat(129)])
    expect(() => s.add({ name: invalid, job: name, cron: '* * * * *' })).toThrow()
  expect(() => s.add({ name, job: name, cron: '* * * * *' })).toThrow()
  expect(() => s.add({ name: 'other', job: 'missing', cron: '* * * * *' })).toThrow()
  for (const cron of ['', '* * * *', '0 * * * * *', '99 * * * *', '0 0 30 2 *', 'bad * * * *'])
    expect(() => s.add({ name: 'other', job: name, cron })).toThrow()
  expect(() => s.add({ name: 'other', job: name, cron: '  0 0 29 2 *  ' })).not.toThrow()
})

test('日和星期取或：月初和每个周一都执行，结果严格晚于起点', () => {
  expect(nextRunAt('0 0 1 * 1', 'UTC', new Date('2030-03-31'))).toEqual(new Date('2030-04-01'))
  expect(nextRunAt('0 0 1 * 1', 'UTC', new Date('2030-04-01'))).toEqual(new Date('2030-04-08'))
  expect(nextRunAt('0 0 1 * 1', 'UTC', new Date('2030-04-29'))).toEqual(new Date('2030-05-01'))
})

test('纽约春季跳过的 02:30 顺延到 03:30，秋季重复的 01:30 只用第一次', () => {
  for (const [cron, start, first, next] of [
    ['30 2 * * *', '2030-03-10T05:00:00Z', '2030-03-10T07:30:00Z', '2030-03-11T06:30:00Z'],
    ['30 1 * * *', '2030-11-03T04:00:00Z', '2030-11-03T05:30:00Z', '2030-11-04T06:30:00Z'],
  ]) {
    expect(nextRunAt(cron!, 'America/New_York', new Date(start!))).toEqual(new Date(first!))
    expect(nextRunAt(cron!, 'America/New_York', new Date(first!))).toEqual(new Date(next!))
  }
})

test('纽约夏令时切换日调度只触发一次，包括秋季第二个相同本地时刻', async () => {
  for (const [cron, start, trigger, repeat] of [
    ['30 2 * * *', '2030-03-10T05:00:00Z', '2030-03-10T07:30:00Z', '2030-03-10T08:30:00Z'],
    ['30 1 * * *', '2030-11-03T04:00:00Z', '2030-11-03T05:30:00Z', '2030-11-03T06:30:00Z'],
  ]) {
    await db().deleteFrom('job_schedules').execute()
    await db().deleteFrom('jobs').execute()
    clock = new Date(start!)
    zone = 'America/New_York'
    const s = scheduler(cron)
    await s.tick()
    clock = new Date(trigger!)
    await s.tick()
    expect(await queue()).toHaveLength(1)
    await db().deleteFrom('jobs').execute()
    clock = new Date(repeat!)
    await s.tick()
    expect(await queue()).toEqual([])
  }
})

test('读取时区失败只记错误类型，下轮恢复后仍可触发', async () => {
  const timeZone = vi.fn(() => Promise.resolve('UTC'))
  const s = createScheduler({
    db: db(),
    jobs: createJobRunner({ db: db(), handlers, now }),
    handlers,
    now,
    timeZone,
    log: (line) => lines.push(line),
  })
  s.add({ name, job: name, cron: '* * * * *' })
  timeZone.mockRejectedValueOnce(new Error('SECRET_CANARY'))
  await s.tick()
  expect(lines).toEqual(['[schedules] tick_failed Error'])
  expect(await db().selectFrom('job_schedules').selectAll().execute()).toEqual([])
  await s.tick()
  clock = new Date('2030-01-01T00:01:00Z')
  await s.tick()
  expect(await queue()).toHaveLength(1)
})

test.each([undefined, null, false, 0, ''])('调度入队只给 undefined 补空对象，保留显式载荷：%j', async (payload) => {
  const s = scheduler()
  s.remove(name)
  s.add({ name, job: name, cron: '0 0 * * *', payload })
  await s.tick()
  clock = new Date('2030-01-02T00:00:00Z')
  await s.tick()
  expect((await queue())[0]?.payload).toBe(JSON.stringify(payload === undefined ? {} : payload))
  expect(lines).toEqual([])
})
