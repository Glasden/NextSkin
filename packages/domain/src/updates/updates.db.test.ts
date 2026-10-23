import { generateKeyPairSync } from 'node:crypto'
import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  upsert,
  writeAuthDate,
  type CoreDatabase,
  type UserRole,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { signEntry, type ReleaseEntry } from '@nextskin/updates'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createCore, type Core, type CoreOptions } from '../core.ts'
import { createUpdates, UPDATE_CHECK_JOB } from './service.ts'
import { createSettingQueries } from '../settings/queries.ts'

const pair = generateKeyPairSync('ed25519')
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const keys = { test: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
const secretKey = 'test-secret-with-at-least-32-characters'
const entry = (version = '0.5.0'): ReleaseEntry => ({
  version,
  date: '2026-10-23T00:00:00.000Z',
  notes: 'https://example.test/notes',
  file: `nextskin-${version}.zip`,
  sha256: 'a'.repeat(64),
  size: 100,
  minNode: 24,
  managerProtocol: 1,
})
const body = (versions = ['0.5.0'], bad = false) =>
  JSON.stringify({
    schema: 1,
    releases: [
      ...versions.map((version) => signEntry(entry(version), privateKey, 'test')),
      ...(bad ? [{ entry: 'untrusted' }] : []),
    ],
  })
let database: TestDatabase<CoreDatabase>
let core: Core
let timestamp: Date
let admin: { uid: number; ip: null }
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
let sequence = 0
const db = () => database.db
const at = () => toIsoTimestamp(timestamp)
const advance = () => {
  timestamp = new Date(timestamp.getTime() + 30_000)
}
const notices = () => db().selectFrom('notifications').selectAll().orderBy('user_id').execute()
const state = async () => (await core.settings.read(['updates.state']))['updates.state']
const user = (role: UserRole) =>
  insertReturningId(db(), 'users', {
    nickname: `user${++sequence}`,
    email: `user${sequence}@example.test`,
    role,
    email_verified: true,
    created_at: writeAuthDate(db(), at()),
    updated_at: writeAuthDate(db(), at()),
  })
function makeCore(release: CoreOptions['release'] = { version: '0.4.0', deployment: 'bundle' }) {
  return createCore({
    db: db(),
    secretKey,
    production: false,
    textureStorage: {
      lateDeleteWindowMs: 0,
      list: () => Promise.resolve([]),
      listTemp: () => Promise.resolve([]),
      read: () => Promise.resolve(null),
      write: async () => {},
      delete: async () => {},
      deleteTemp: async () => {},
    },
    now: () => timestamp,
    release,
    updateCheck: { fetch: fetcher, keys },
  })
}
const service = (release: CoreOptions['release'] = { version: '0.4.0', deployment: 'bundle' }) =>
  createUpdates({
    db: db(),
    settings: createSettingQueries(db(), secretKey),
    secretKey,
    now: () => timestamp,
    release,
    updateCheck: { fetch: fetcher, keys },
  })
async function enabled(value: boolean) {
  await upsert(db(), 'settings', {
    values: { namespace: 'core', key: 'updates.check', value: JSON.stringify(value), updated_at: at() },
    conflict: ['namespace', 'key'],
    update: ['value'],
  })
}
const run = (updates = service()) =>
  updates.handler.run({ jobId: 0, payload: {}, attempt: 1, signal: new AbortController().signal })
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
})
afterAll(async () => database?.cleanup())
afterEach(async () => {
  await core?.schedules.stop()
  await core?.shutdown()
})
beforeEach(async () => {
  for (const table of [
    'notifications',
    'audit_logs',
    'jobs',
    'failed_jobs',
    'job_schedules',
    'settings',
    'users',
  ] as const)
    await db().deleteFrom(table).execute()
  timestamp = new Date('2026-10-23T01:00:00.000Z')
  fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(body())))
  core = makeCore()
  admin = { uid: await user('superadmin'), ip: null }
})

test('保存成功状态，向每位超级管理员发一次通知，重复检测不重复，无审计', async () => {
  const other = await user('superadmin')
  await user('admin')
  await user('user')
  await user('banned')
  const result = await core.updates.check(admin)
  expect(result).toEqual({
    enabled: true,
    current: '0.4.0',
    deployment: 'bundle',
    checkedAt: at(),
    failure: null,
    latest: { version: '0.5.0', date: entry().date, notes: entry().notes, minNode: 24 },
  })
  expect(await state()).toMatchObject({ notified: ['0.5.0'], rejected: 0 })
  advance()
  await core.updates.check(admin)
  expect((await notices()).map((row) => [row.user_id, row.type, JSON.parse(row.params!) as unknown])).toEqual(
    [admin.uid, other].sort((a, b) => a - b).map((uid) => [uid, 'update.available', { version: '0.5.0' }]),
  )
  expect(await db().selectFrom('audit_logs').selectAll().execute()).toEqual([])
  for (const locale of ['zh-CN', 'en'] as const) {
    const notification = (await core.notifications.summary(admin.uid, locale)).latest[0]!
    expect(notification.link).toBe('/admin/updates')
    expect(notification.title).toContain('0.5.0')
  }
})
test('两个实例的定时与立即检查同时读清单，在事务里按版本去重', async () => {
  const other = await user('superadmin')
  let arrived = 0
  let release!: () => void
  const both = new Promise<void>((resolve) => {
    release = resolve
  })
  fetcher.mockImplementation(async () => {
    if (++arrived === 2) release()
    await both
    return new Response(body())
  })
  await Promise.all([run(service()), core.updates.check(admin)])
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect((await notices()).map((row) => row.user_id).sort((a, b) => a - b)).toEqual(
    [admin.uid, other].sort((a, b) => a - b),
  )
  expect((await state()).notified).toEqual(['0.5.0'])
})
test('没有新版本不通知，升级后旧记录自然失效', async () => {
  await core.updates.check(admin)
  expect(await service({ version: '0.5.0', deployment: 'docker' }).status(admin)).toMatchObject({
    current: '0.5.0',
    deployment: 'docker',
    latest: null,
  })
  advance()
  fetcher.mockImplementation(() => Promise.resolve(new Response(body(['0.4.0', '0.3.0']))))
  expect((await core.updates.check(admin)).latest).toBeNull()
  expect(await notices()).toHaveLength(1)
})
test('预发布版本可升级到同版本的正式版，清单本地排序', async () => {
  fetcher.mockImplementation(() => Promise.resolve(new Response(body(['0.3.0', '0.4.0']))))
  expect((await service({ version: '0.4.0-rc.1', deployment: 'docker' }).check(admin)).latest?.version).toBe('0.4.0')
})
test('坏条目只计数，合法条目照常生效', async () => {
  fetcher.mockImplementation(() => Promise.resolve(new Response(body(['0.5.0'], true))))
  await core.updates.check(admin)
  expect(await state()).toMatchObject({ rejected: 1, notified: ['0.5.0'] })
})
test.each(['network', 'http', 'invalid', 'too_large'] as const)(
  '失败 %s 不清掉上次成功的结果，也不进入死信',
  async (code) => {
    await core.updates.check(admin)
    const success = await state()
    advance()
    fetcher.mockImplementation(() => {
      if (code === 'network') return Promise.reject(new Error('sensitive remote text'))
      return Promise.resolve(
        code === 'http'
          ? new Response('sensitive remote text', { status: 503 })
          : new Response(code === 'invalid' ? '{' : 'x'.repeat(1024 * 1024 + 1)),
      )
    })
    await run()
    expect(await state()).toEqual({
      ...success,
      failure: { at: at(), code, ...(code === 'http' ? { status: 503 } : {}) },
    })
    expect(await db().selectFrom('failed_jobs').selectAll().execute()).toEqual([])
    expect(await notices()).toHaveLength(1)
    await core.updates.check(admin)
    expect(fetcher).toHaveBeenCalledTimes(2)
  },
)
test('30 秒内重复检查不请求，边界后可检查；同实例并发合并', async () => {
  await Promise.all([core.updates.check(admin), core.updates.check(admin)])
  expect(fetcher).toHaveBeenCalledTimes(1)
  timestamp = new Date(timestamp.getTime() + 29_999)
  await core.updates.check(admin)
  expect(fetcher).toHaveBeenCalledTimes(1)
  timestamp = new Date(timestamp.getTime() + 1)
  await core.updates.check(admin)
  expect(fetcher).toHaveBeenCalledTimes(2)
})
test('关闭时定时任务不请求，手动检查报错，status 可读', async () => {
  await enabled(false)
  await run()
  await expect(core.updates.check(admin)).rejects.toMatchObject({ code: 'updates_disabled' })
  expect((await core.updates.status(admin)).enabled).toBe(false)
  expect(fetcher).not.toHaveBeenCalled()
})
test('源码运行不请求，status 返回 source，手动检查报错', async () => {
  const source = createUpdates({
    db: db(),
    settings: core.settings,
    secretKey,
    now: () => timestamp,
    updateCheck: { fetch: fetcher, keys },
  })
  await run(source)
  await expect(source.check(admin)).rejects.toMatchObject({ code: 'updates_unavailable' })
  expect(await source.status(admin)).toMatchObject({ current: null, deployment: 'source', latest: null })
  expect(fetcher).not.toHaveBeenCalled()
})
test.each(['admin', 'user', 'banned'] as const)('%s 不能查询或检查，身份重新查库', async (role) => {
  await db().updateTable('users').set({ role }).where('id', '=', admin.uid).execute()
  await expect(core.updates.status(admin)).rejects.toMatchObject({ code: 'permission_denied' })
  await expect(core.updates.check(admin)).rejects.toMatchObject({ code: 'permission_denied' })
  expect(fetcher).not.toHaveBeenCalled()
})
test('核心登记每日任务并由 runner 执行，网络失败完成任务而不重试', async () => {
  core.schedules.start()
  await core.schedules.tick()
  await core.schedules.stop()
  expect(
    await db()
      .selectFrom('job_schedules')
      .select(['name', 'cron'])
      .where('name', '=', UPDATE_CHECK_JOB)
      .executeTakeFirst(),
  ).toEqual({ name: UPDATE_CHECK_JOB, cron: '43 5 * * *' })
  fetcher.mockRejectedValue(new Error('untrusted'))
  await db()
    .transaction()
    .execute((tx) => core.jobs.enqueue(tx, UPDATE_CHECK_JOB, {}))
  await core.jobs.drain()
  expect(await state()).toMatchObject({ failure: { code: 'network' } })
  expect(await db().selectFrom('jobs').selectAll().execute()).toEqual([])
  expect(await db().selectFrom('failed_jobs').selectAll().execute()).toEqual([])
})
test('只保留最近 20 个已通知版本号', async () => {
  for (let i = 1; i <= 21; i++) {
    fetcher.mockImplementation(() => Promise.resolve(new Response(body([`1.0.${i}`]))))
    await core.updates.check(admin)
    advance()
  }
  expect((await state()).notified).toEqual(Array.from({ length: 20 }, (_, i) => `1.0.${i + 2}`))
})

test('等待清单时不持有数据库事务，其他写操作可以完成', async () => {
  let started!: () => void
  const fetching = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish!: (response: Response) => void
  const response = new Promise<Response>((resolve) => {
    finish = resolve
  })
  fetcher.mockImplementation(() => {
    started()
    return response
  })
  const checking = core.updates.check(admin)
  await fetching
  try {
    await user('user')
  } finally {
    finish(new Response(body()))
  }
  await checking
  expect((await state()).latest?.version).toBe('0.5.0')
})
