import { randomUUID } from 'node:crypto'
import { coreMigrations, migrateToLatest, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createJobRunner, type JobHandler } from '../jobs/runner.ts'
import { createTextureFiles, TEXTURE_RECYCLE_JOB } from './files.ts'
import type { TextureStorage } from './storage.ts'
import { createTextureSweep, TEXTURE_SWEEP_JOB } from './sweep.ts'

let database: TestDatabase<CoreDatabase>
let clock: number
const db = () => database.db
const now = () => new Date(clock)
const hash = (n: number) => n.toString(16).padStart(64, '0')
const objects = new Map<string, Date>()
const temps: { hash: string; claimId: string; modifiedAt: Date }[] = []
const lines: string[] = []
let storage: ReturnType<typeof createStorage>
let files: ReturnType<typeof createTextureFiles>
let jobs: ReturnType<typeof createJobRunner>
let sweep: JobHandler
const iso = (offset = 0) => toIsoTimestamp(new Date(clock + offset))
const day = 86_400_000
const leaseMs = 600_000
const deleteDelayMs = 3_600_000
const old = () => new Date(clock - 2 * day)
const run = (payload: unknown = {}, jobId = 0) =>
  sweep.run({ jobId, payload, attempt: 1, signal: new AbortController().signal })
function createStorage() {
  return {
    lateDeleteWindowMs: 0,
    read: () => Promise.resolve(null),
    write: () => Promise.resolve(),
    delete: vi.fn<TextureStorage['delete']>((key) => {
      objects.delete(key)
      return Promise.resolve()
    }),
    deleteTemp: vi.fn<TextureStorage['deleteTemp']>(() => Promise.resolve()),
    list: vi.fn<TextureStorage['list']>(({ after, limit }) =>
      Promise.resolve(
        [...objects]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .filter(([key]) => after === null || key > after)
          .slice(0, limit)
          .map(([key, modifiedAt]) => ({ key, modifiedAt })),
      ),
    ),
    listTemp: vi.fn<TextureStorage['listTemp']>(() => Promise.resolve(temps)),
  }
}
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db().deleteFrom('jobs').execute()
  await db().deleteFrom('texture_files').execute()
  objects.clear()
  temps.length = 0
  lines.length = 0
  clock = Date.parse('2030-01-01T00:00:00Z')
  storage = createStorage()
  const handlers = new Map<string, JobHandler>()
  jobs = createJobRunner({ db: db(), handlers, now, log: (line) => lines.push(line) })
  files = createTextureFiles({
    db: db(),
    storage,
    renders: { purge: async () => {} },
    jobs,
    now,
    leaseMs,
    deleteDelayMs,
  })
  for (const [name, handler] of Object.entries(files.handlers)) handlers.set(name, handler)
  sweep = createTextureSweep({ db: db(), storage, files, jobs, now, leaseMs, log: (line) => lines.push(line) })
  handlers.set(TEXTURE_SWEEP_JOB, sweep)
})

async function pending(key: string, claimId = randomUUID()) {
  await db()
    .insertInto('texture_files')
    .values({
      hash: key,
      status: 'pending',
      pixel_hash: null,
      width: null,
      height: null,
      size_bytes: null,
      ref_count: 0,
      claim_id: claimId,
      status_changed_at: iso(),
      created_at: iso(),
      delete_attempted_at: null,
      delete_confirmed_at: null,
    })
    .execute()
  return claimId
}

test('孤儿认领为 deleting，并在同一事务排回收；经过 D 后沿正常流程删除对象和行', async () => {
  objects.set(hash(1), old())
  await run()
  expect(await db().selectFrom('texture_files').selectAll().execute()).toMatchObject([
    {
      hash: hash(1),
      status: 'deleting',
      ref_count: 0,
      pixel_hash: null,
      width: null,
      height: null,
      size_bytes: null,
      delete_attempted_at: null,
      delete_confirmed_at: null,
    },
  ])
  expect(await db().selectFrom('jobs').selectAll().execute()).toMatchObject([
    { name: TEXTURE_RECYCLE_JOB, dedupe_key: hash(1), run_at: iso(deleteDelayMs + 1) },
  ])
  expect((await db().selectFrom('texture_files').select('claim_id').executeTakeFirstOrThrow()).claim_id).toEqual(
    expect.any(String),
  )
  expect(lines).toEqual(['[jobs] texture_sweep orphans=1 temps=0'])
  clock += deleteDelayMs
  await jobs.drain()
  expect(objects.has(hash(1))).toBe(true)
  clock++
  await jobs.drain()
  expect(objects.has(hash(1))).toBe(false)
  expect(await db().selectFrom('texture_files').selectAll().execute()).toEqual([])
})

test('已有行及不到一天或正好一天的文件不动，重复认领返回零', async () => {
  objects.set(hash(1), old())
  const claimId = await pending(hash(1))
  objects.set(hash(2), new Date(clock - day + 1))
  objects.set(hash(3), new Date(clock - day))
  await run()
  expect(await db().selectFrom('texture_files').selectAll().execute()).toMatchObject([
    { hash: hash(1), status: 'pending', claim_id: claimId },
  ])
  expect(await files.adoptOrphans([hash(1)])).toBe(0)
  expect(await db().selectFrom('jobs').selectAll().execute()).toEqual([])
  expect(lines).toEqual(['[jobs] texture_sweep orphans=0 temps=0'])
})

test('候选查询后被并发认领时走真实冲突插入，不重复排任务或计数', async () => {
  const key = hash(1)
  objects.set(key, old())
  const claimId = randomUUID()
  // 查询结果已经取回，但 sweep 尚未看到结果；另一实例先插入同一个 hash。
  const racingDb = db().withPlugin({
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      expect(result.rows).toEqual([])
      await pending(key, claimId)
      return result
    },
  })
  const racingSweep = createTextureSweep({
    db: racingDb,
    storage,
    files,
    jobs,
    now,
    leaseMs,
    log: (line) => lines.push(line),
  })
  const adopt = vi.spyOn(files, 'adoptOrphans')
  const enqueue = vi.spyOn(jobs, 'enqueue')
  await racingSweep.run({ jobId: 0, payload: {}, attempt: 1, signal: new AbortController().signal })
  expect(adopt).toHaveBeenCalledWith([key])
  expect(await db().selectFrom('texture_files').selectAll().execute()).toMatchObject([
    { hash: key, status: 'pending', claim_id: claimId },
  ])
  expect(enqueue).not.toHaveBeenCalled()
  expect(await db().selectFrom('jobs').selectAll().execute()).toEqual([])
  expect(lines).toEqual(['[jobs] texture_sweep orphans=0 temps=0'])
})

test('整页孤儿认领中途入队失败时全部回滚，重试正确累计整页计数', async () => {
  objects.set(hash(1), old())
  objects.set(hash(2), old())
  const enqueue = jobs.enqueue.bind(jobs)
  vi.spyOn(jobs, 'enqueue').mockImplementationOnce(enqueue).mockRejectedValueOnce(new Error('failed'))
  await expect(run()).rejects.toThrow('failed')
  expect(await db().selectFrom('texture_files').selectAll().execute()).toEqual([])
  expect(await db().selectFrom('jobs').selectAll().execute()).toEqual([])
  expect(lines).toEqual([])
  await run()
  expect(await db().selectFrom('texture_files').selectAll().execute()).toHaveLength(2)
  expect(await db().selectFrom('jobs').selectAll().execute()).toHaveLength(2)
  expect(lines).toEqual(['[jobs] texture_sweep orphans=2 temps=0'])
})

test('临时文件只删超过租期且不是当前 pending 认领的文件', async () => {
  const live = randomUUID(),
    stale = randomUUID(),
    deleting = randomUUID()
  await pending(hash(1), live)
  await files.adoptOrphans([hash(2)])
  temps.push(
    { hash: hash(1), claimId: live, modifiedAt: old() },
    { hash: hash(1), claimId: stale, modifiedAt: old() },
    { hash: hash(2), claimId: deleting, modifiedAt: old() },
    { hash: hash(3), claimId: randomUUID(), modifiedAt: new Date(clock - leaseMs + 1) },
    { hash: hash(4), claimId: randomUUID(), modifiedAt: new Date(clock - leaseMs) },
    { hash: hash(5), claimId: randomUUID(), modifiedAt: old() },
  )
  await run()
  expect(storage.deleteTemp).toHaveBeenCalledTimes(3)
  expect(storage.deleteTemp).toHaveBeenCalledWith(hash(1), stale)
  expect(storage.deleteTemp).toHaveBeenCalledWith(hash(2), deleting)
  expect(storage.deleteTemp).toHaveBeenCalledWith(hash(5), temps[5]!.claimId)
  expect(lines).toEqual(['[jobs] texture_sweep orphans=0 temps=3'])
})

test('满一页释放旧任务的去重键再续跑，游标和累计计数保留且不重扫临时文件', async () => {
  // 大部分对象尚新，既覆盖满页续跑，也避免为测试制造一千个回收任务。
  for (let i = 1; i <= 1001; i++) objects.set(hash(i), new Date(clock))
  objects.set(hash(1), old())
  objects.set(hash(1001), old())
  temps.push({ hash: hash(2), claimId: randomUUID(), modifiedAt: old() })
  await jobs.enqueue(db(), TEXTURE_SWEEP_JOB, {}, { dedupeKey: TEXTURE_SWEEP_JOB })
  const first = await db()
    .selectFrom('jobs')
    .select('id')
    .where('name', '=', TEXTURE_SWEEP_JOB)
    .executeTakeFirstOrThrow()
  await run({}, first.id)
  const rows = await db().selectFrom('jobs').selectAll().where('name', '=', TEXTURE_SWEEP_JOB).orderBy('id').execute()
  expect(rows).toHaveLength(2)
  expect(rows[0]!.dedupe_key).toBeNull()
  expect(rows[1]!.dedupe_key).toBe(TEXTURE_SWEEP_JOB)
  expect(JSON.parse(rows[1]!.payload)).toEqual({ after: hash(1000), orphans: 1, temps: 1 })
  expect(lines).toEqual([])
  await run(JSON.parse(rows[1]!.payload), rows[1]!.id)
  expect(storage.listTemp).toHaveBeenCalledTimes(1)
  expect(storage.list).toHaveBeenLastCalledWith({ after: hash(1000), limit: 1000 })
  expect(lines).toEqual(['[jobs] texture_sweep orphans=2 temps=1'])
})

test('非法续跑载荷拒绝；取消后不动存储或数据库', async () => {
  for (const payload of [{ after: '../path' }, { orphans: -1 }, { temps: 1.5 }])
    await expect(run(payload)).rejects.toThrow()
  const controller = new AbortController()
  controller.abort()
  await expect(sweep.run({ jobId: 0, payload: {}, attempt: 1, signal: controller.signal })).rejects.toThrow()
  expect(storage.list).not.toHaveBeenCalled()
})

test('执行器实际续跑到末页，整轮只扫描一次临时目录并保留合计日志', async () => {
  for (let i = 1; i <= 1001; i++) objects.set(hash(i), now())
  objects.set(hash(1), old())
  objects.set(hash(1001), old())
  temps.push({ hash: hash(2), claimId: randomUUID(), modifiedAt: old() })
  await jobs.enqueue(db(), TEXTURE_SWEEP_JOB, {}, { dedupeKey: TEXTURE_SWEEP_JOB })
  await jobs.drain()
  expect(await db().selectFrom('jobs').selectAll().where('name', '=', TEXTURE_SWEEP_JOB).execute()).toEqual([])
  expect(await db().selectFrom('jobs').selectAll().where('name', '=', TEXTURE_RECYCLE_JOB).execute()).toHaveLength(2)
  expect(storage.listTemp).toHaveBeenCalledTimes(1)
  expect(lines).toEqual(['[jobs] texture_sweep orphans=2 temps=1'])
})

test('已提交续跑的页崩溃重试只释放自己的去重键，不产生第二条续跑链', async () => {
  for (let i = 1; i <= 1000; i++) objects.set(hash(i), now())
  await jobs.enqueue(db(), TEXTURE_SWEEP_JOB, {}, { dedupeKey: TEXTURE_SWEEP_JOB })
  const first = await db()
    .selectFrom('jobs')
    .selectAll()
    .where('name', '=', TEXTURE_SWEEP_JOB)
    .executeTakeFirstOrThrow()
  await run({}, first.id)
  const next = await db()
    .selectFrom('jobs')
    .selectAll()
    .where('name', '=', TEXTURE_SWEEP_JOB)
    .where('id', '!=', first.id)
    .executeTakeFirstOrThrow()
  expect(next.dedupe_key).toBe(TEXTURE_SWEEP_JOB)
  // A 已提交 B，但尚未由执行器删除；模拟 A 租约到期后再次执行。
  await run({}, first.id)
  expect(
    await db()
      .selectFrom('jobs')
      .selectAll()
      .where('name', '=', TEXTURE_SWEEP_JOB)
      .where('id', '!=', first.id)
      .execute(),
  ).toEqual([next])
  expect(
    await db()
      .selectFrom('jobs')
      .selectAll()
      .where('name', '=', TEXTURE_SWEEP_JOB)
      .where('dedupe_key', '=', TEXTURE_SWEEP_JOB)
      .execute(),
  ).toEqual([next])
  await db().deleteFrom('jobs').where('id', '=', first.id).execute()
  expect(await db().selectFrom('jobs').selectAll().where('name', '=', TEXTURE_SWEEP_JOB).execute()).toEqual([next])
})
