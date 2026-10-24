import { generateKeyPairSync } from 'node:crypto'
import { Socket } from 'node:net'
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
import { type ManagerClientOptions, type ManagerMethod, type ManagerStatus } from './manager-client.ts'
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
function makeCore(
  release: CoreOptions['release'] = { version: '0.4.0', deployment: 'bundle' },
  manager?: ManagerClientOptions,
) {
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
    manager,
    updateCheck: { fetch: fetcher, keys },
  })
}
const service = (
  release: CoreOptions['release'] = { version: '0.4.0', deployment: 'bundle' },
  manager?: ManagerClientOptions,
) =>
  createUpdates({
    db: db(),
    settings: createSettingQueries(db(), secretKey),
    secretKey,
    now: () => timestamp,
    release,
    manager,
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
    manager: { available: false, reason: 'unmanaged' },
    enabled: true,
    current: '0.4.0',
    deployment: 'bundle',
    checkedAt: at(),
    failure: null,
    latest: { version: '0.5.0', date: entry().date, notes: entry().notes, minNode: 24, managerProtocol: 1 },
    target: null,
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
  expect((await state()).releases[0]?.version).toBe('0.5.0')
})

const managerState: ManagerStatus = {
  protocol: 1,
  version: '0.4.0',
  current: '0.4.0',
  previous: '0.3.0',
  writable: true,
  operation: null,
  prepared: null,
  lastResult: null,
  failed: [],
  rollback: { version: '0.3.0', migrations: false, dialect: 'sqlite', backupAvailable: false },
}
function managerConnection() {
  const status = structuredClone(managerState)
  const reply = vi.fn<(method: ManagerMethod, params: unknown) => unknown>((method) => ({
    ok: true,
    result: method === 'status' ? status : method === 'cancel' ? { cancelled: true } : { accepted: true },
  }))
  const connect = vi.fn(() => {
    const socket = new Socket()
    vi.spyOn(socket, 'write').mockImplementation((line) => {
      const request = JSON.parse(String(line)) as { method: ManagerMethod; params: unknown }
      void Promise.resolve()
        .then(() => reply(request.method, request.params))
        .then((result) => {
          socket.emit('data', Buffer.from(JSON.stringify(result) + '\n'))
        })
        .catch(() => socket.destroy())
      return true
    })
    queueMicrotask(() => socket.emit('connect'))
    return socket
  })
  return { options: { address: 'unused', token: 'a'.repeat(64), connect }, connect, reply, status }
}
const logs = async () =>
  (await db().selectFrom('audit_logs').selectAll().orderBy('id').execute()).map((row) => ({
    ...row,
    details: JSON.parse(row.details) as Record<string, unknown>,
  }))
const commandCases = [
  ['prepare', { version: '0.5.0' }],
  ['apply', { version: '0.5.0', backupConfirmed: true }],
  ['rollback', { confirmed: true }],
] as const
function invoke(updates: ReturnType<typeof createUpdates>, method: 'prepare' | 'apply' | 'rollback') {
  if (method === 'prepare') return updates.prepare(admin, '0.5.0')
  if (method === 'apply') return updates.apply(admin, '0.5.0', { backupConfirmed: true })
  return updates.rollback(admin, { confirmed: true })
}
test.each(commandCases)('%s 转发后独立事务写成功审计', async (method, params) => {
  const manager = managerConnection()
  const updates = service(undefined, manager.options)
  expect(await invoke(updates, method)).toEqual({ accepted: true })
  expect(manager.reply).toHaveBeenLastCalledWith(method, params)
  expect(await logs()).toMatchObject([
    {
      actor_type: 'user',
      actor_user_id: admin.uid,
      actor_plugin_id: null,
      action: `update.${method}`,
      subject_type: 'update',
      subject_id: 0,
      ip: admin.ip,
      created_at: at(),
      details: {
        version: method === 'rollback' ? '0.3.0' : '0.5.0',
        accepted: true,
        ...(method === 'apply' ? { backupConfirmed: true } : {}),
        ...(method === 'rollback' ? { confirmed: true } : {}),
      },
    },
  ])
})
test.each(commandCases)('%s 被拒绝同样写审计，只记错误码不记消息', async (method) => {
  const manager = managerConnection()
  manager.reply.mockImplementation((m) =>
    m === 'status'
      ? { ok: true, result: manager.status }
      : { ok: false, error: { code: 'busy', message: '详细原因 ' + manager.options.token } },
  )
  const updates = service(undefined, manager.options)
  await expect(invoke(updates, method)).rejects.toMatchObject({
    code: 'update_busy',
    params: { message: '详细原因 [redacted]' },
  })
  const entries = await logs()
  expect(entries).toHaveLength(1)
  expect(entries[0]!.details).toEqual({
    version: method === 'rollback' ? '0.3.0' : '0.5.0',
    accepted: false,
    code: 'update_busy',
    ...(method === 'apply' ? { backupConfirmed: true } : {}),
    ...(method === 'rollback' ? { confirmed: true } : {}),
  })
  expect(JSON.stringify(entries)).not.toContain(manager.options.token)
  expect(JSON.stringify(entries)).not.toContain('详细原因')
})
test.each(['admin', 'user', 'banned'] as const)('%s 不能调用管理进程，身份以数据库为准', async (role) => {
  const manager = managerConnection()
  const updates = service(undefined, manager.options)
  await db().updateTable('users').set({ role }).where('id', '=', admin.uid).execute()
  for (const method of ['prepare', 'apply', 'rollback'] as const)
    await expect(invoke(updates, method)).rejects.toMatchObject({ code: 'permission_denied' })
  await expect(updates.cancel(admin)).rejects.toMatchObject({ code: 'permission_denied' })
  await expect(updates.status(admin)).rejects.toMatchObject({ code: 'permission_denied' })
  expect(manager.connect).not.toHaveBeenCalled()
  expect(await logs()).toEqual([])
})
test.each(['1.2', 'v1.2.3', '01.2.3', '1.2.3-rc.1', '1.2.3+build', '1.2.3\n', '', '../1.2.3'])(
  '正式版本号校验：%j',
  async (version) => {
    const manager = managerConnection()
    const updates = service(undefined, manager.options)
    await expect(updates.prepare(admin, version)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(updates.apply(admin, version, { backupConfirmed: false })).rejects.toMatchObject({
      code: 'invalid_request',
    })
    expect(manager.connect).not.toHaveBeenCalled()
    expect(await logs()).toEqual([])
  },
)
test.each([undefined, null, 0, 1, 'false', 'true'])('确认值严格校验：%j', async (value) => {
  const manager = managerConnection()
  const updates = service(undefined, manager.options)
  await expect(updates.apply(admin, '0.5.0', { backupConfirmed: value as unknown as boolean })).rejects.toMatchObject({
    code: 'invalid_request',
  })
  await expect(updates.rollback(admin, { confirmed: value as unknown as boolean })).rejects.toMatchObject({
    code: 'invalid_request',
  })
  expect(manager.connect).not.toHaveBeenCalled()
})
test('false 确认值原样传递，cancel 返回管理进程结果且不写审计', async () => {
  const manager = managerConnection()
  const updates = service(undefined, manager.options)
  await updates.apply(admin, '0.5.0', { backupConfirmed: false })
  await updates.rollback(admin, { confirmed: false })
  expect(manager.reply).toHaveBeenCalledWith('apply', { version: '0.5.0', backupConfirmed: false })
  expect(manager.reply).toHaveBeenCalledWith('rollback', { confirmed: false })
  manager.reply.mockReturnValue({ ok: true, result: { cancelled: false } })
  expect(await updates.cancel(admin)).toEqual({ cancelled: false })
  expect(manager.reply).toHaveBeenLastCalledWith('cancel', {})
  expect(await logs()).toHaveLength(2)
})
test('status 的五种不可用原因与完整可用状态；源码和 Docker 不连接', async () => {
  const manager = managerConnection()
  const source = createUpdates({
    db: db(),
    settings: core.settings,
    secretKey,
    now: () => timestamp,
    manager: manager.options,
  })
  expect((await source.status(admin)).manager).toEqual({ available: false, reason: 'source' })
  expect((await service({ version: '0.4.0', deployment: 'docker' }, manager.options).status(admin)).manager).toEqual({
    available: false,
    reason: 'docker',
  })
  expect((await service().status(admin)).manager).toEqual({ available: false, reason: 'unmanaged' })
  expect(manager.connect).not.toHaveBeenCalled()
  const updates = service(undefined, manager.options)
  expect((await updates.status(admin)).manager).toEqual({ available: true, ...managerState })
  manager.status.writable = false
  expect((await updates.status(admin)).manager).toEqual({ available: false, reason: 'readonly' })
  manager.reply.mockReturnValue({ ok: true, result: { invalid: true } })
  expect((await updates.status(admin)).manager).toEqual({ available: false, reason: 'unreachable' })
  manager.connect.mockImplementation(() => {
    throw new Error('untrusted')
  })
  expect((await updates.status(admin)).manager).toEqual({ available: false, reason: 'unreachable' })
  await expect(updates.prepare(admin, '0.5.0')).rejects.toMatchObject({ code: 'update_unreachable' })
  expect((await logs())[0]!.details).toEqual({ version: '0.5.0', accepted: false, code: 'update_unreachable' })
  await expect(source.prepare(admin, '0.5.0')).rejects.toMatchObject({ code: 'updates_unavailable' })
})
test('核心构造选项把控制通道注入 updates', async () => {
  const manager = managerConnection()
  const managedCore = makeCore(undefined, manager.options)
  try {
    expect((await managedCore.updates.status(admin)).manager).toEqual({ available: true, ...managerState })
  } finally {
    await managedCore.shutdown()
  }
})
test('等 IPC 的时候没有数据库事务，其他写操作可完成，审计等确认之后才写', async () => {
  const manager = managerConnection()
  let started!: () => void
  const arrived = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish!: (value: unknown) => void
  const response = new Promise((resolve) => {
    finish = resolve
  })
  manager.reply.mockImplementation(() => {
    started()
    return response
  })
  const preparing = service(undefined, manager.options).prepare(admin, '0.5.0')
  await arrived
  try {
    await user('user')
    expect(await logs()).toEqual([])
  } finally {
    finish({ ok: true, result: { accepted: true } })
  }
  await preparing
  expect(await logs()).toHaveLength(1)
})

test('每个协议只保留最新正式版，管理进程按自身协议选择目标，通知仍取最新版本', async () => {
  const releases = [
    { ...entry('0.6.0'), managerProtocol: 2 },
    entry('0.4.0'),
    { ...entry('0.8.0'), managerProtocol: 3 },
    entry('0.5.0'),
    { ...entry('0.7.0'), managerProtocol: 2 },
  ]
  fetcher.mockImplementation(() =>
    Promise.resolve(
      Response.json({
        schema: 1,
        releases: releases.map((release) => signEntry(release, privateKey, 'test')),
      }),
    ),
  )
  const manager = managerConnection()
  const updates = service(undefined, manager.options)
  expect(await updates.check(admin)).toMatchObject({ latest: { version: '0.8.0' }, target: { version: '0.5.0' } })
  expect((await state()).releases.map(({ version, managerProtocol }) => [version, managerProtocol])).toEqual([
    ['0.8.0', 3],
    ['0.7.0', 2],
    ['0.5.0', 1],
  ])
  expect((await state()).notified).toEqual(['0.8.0'])
  manager.status.protocol = 2
  expect((await updates.status(admin)).target?.version).toBe('0.7.0')
  manager.status.protocol = 3
  expect((await updates.status(admin)).target?.version).toBe('0.8.0')
  manager.status.writable = false
  expect((await updates.status(admin)).target).toBeNull()
  expect(
    (await service({ version: '0.5.0', deployment: 'bundle' }, manager.options).status(admin)).latest?.version,
  ).toBe('0.8.0')
  manager.status.writable = true
  manager.status.protocol = 1
  expect((await service({ version: '0.5.0', deployment: 'bundle' }, manager.options).status(admin)).target).toBeNull()
  expect((await service({ version: '0.8.0', deployment: 'bundle' }, manager.options).status(admin)).latest).toBeNull()
})
