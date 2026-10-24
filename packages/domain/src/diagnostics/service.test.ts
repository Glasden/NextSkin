import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as databaseModule from '@nextskin/db'
import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { LOG_FILE_DROPPED, LOG_IPC_DROPPED } from '@nextskin/logging'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createCore, type Core } from '../core.ts'
import { createLocalTextureStorage } from '../textures/storage.ts'
import { coreSettingsRegistry, type CoreSettingKey } from '../settings/registry.ts'
import { encodeSettingValue } from '../settings/codec.ts'
import { insertJob } from '../jobs/store.ts'
import { createDiagnostics } from './service.ts'

const secretKey = 'diagnostics-test-secret-at-least-32-characters'
const timestamp = new Date('2026-10-24T15:30:12Z')
const at = toIsoTimestamp(timestamp)
let database: TestDatabase<CoreDatabase>
let directory: string
let core: Core
let actor: { uid: number; ip: string }
const db = () => database.db
let sequence = 0
const user = (role: 'user' | 'admin' | 'superadmin' | 'banned') =>
  insertReturningId(db(), 'users', {
    nickname: `diagnostics${++sequence}`,
    email: `diagnostics${sequence}@example.test`,
    role,
    email_verified: true,
    created_at: writeAuthDate(db(), at),
    updated_at: writeAuthDate(db(), at),
  })
beforeAll(async () => {
  database = await createTestDatabase()
  await migrateToLatest(db(), coreMigrations)
})
afterAll(async () => {
  await database?.cleanup()
})
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'diagnostics-service-'))
  actor = { uid: await user('superadmin'), ip: '8.8.8.8' }
  core = createCore({
    db: db(),
    secretKey,
    production: false,
    textureStorage: createLocalTextureStorage(join(directory, 'textures')),
    now: () => timestamp,
    dataDirectory: directory,
    instanceDirectory: directory,
    fileLogging: true,
    envNames: ['NEXTSKIN_MANAGER_TOKEN', 'NEXTSKIN_SECRET_KEY'],
    runMode: 'launcher',
  })
  await db().deleteFrom('jobs').execute()
  await db().deleteFrom('failed_jobs').execute()
  await db().deleteFrom('plugins').execute()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await core.shutdown()
  await rm(directory, { recursive: true, force: true })
})
const log = (msg: string, dropped: number, time: string = at) =>
  JSON.stringify({ time, level: 'warn', source: 'core', msg, dropped })

test.each(['user', 'admin', 'banned'] as const)('%s 不能读取摘要、日志或导出，拒绝时不写审计', async (role) => {
  const denied = { uid: await user(role), ip: null }
  for (const call of [
    () => core.diagnostics.summary(denied),
    () => core.diagnostics.logs(denied, {}),
    () => core.diagnostics.export(denied),
  ])
    await expect(call()).rejects.toMatchObject({ code: 'permission_denied' })
  expect(await db().selectFrom('audit_logs').select('id').where('actor_user_id', '=', denied.uid).execute()).toEqual([])
})
test('摘要的时钟、版本、空间、迁移、核心死信、到期任务与最近 24 小时丢弃量', async () => {
  const future = toIsoTimestamp(new Date(timestamp.getTime() + 60000))
  await insertJob(db(), { name: 'core:test', payload: {}, runAt: future }, at)
  await insertJob(db(), { name: 'plugin:demo:test', payload: {}, runAt: at }, at)
  for (const name of ['core:test', 'plugin:demo:test'])
    await db()
      .insertInto('failed_jobs')
      .values({ name, payload: '{}', attempts: 1, last_error: 'fixed_error', created_at: at, failed_at: at })
      .execute()
  await mkdir(join(directory, 'logs'))
  const lines = [
    log(LOG_FILE_DROPPED, 3),
    log(LOG_IPC_DROPPED, 4),
    log(LOG_IPC_DROPPED, 100, '2026-10-23T00:00:00.000Z'),
    log('other', 500),
    log(LOG_IPC_DROPPED, -1),
  ]
  await writeFile(join(directory, 'logs', 'nextskin.log'), lines.join('\n') + '\n')
  const summary = await core.diagnostics.summary(actor)
  expect(summary).toMatchObject({
    runMode: 'launcher',
    startedAt: at,
    versions: { nextskin: null },
    database: { dialect: 'sqlite', pendingCore: 0, unknownCore: 0, pendingPlugins: [] },
    storage: { dataDirectory: directory, fileLogging: true, logFiles: 1, droppedRecently: 7, droppedComplete: true },
    jobs: { queued: 2, oldestDueAt: at, deadLetters: 1 },
    lastUpdate: null,
    pluginHost: { state: 'disabled' },
  })
  expect(summary.database.serverVersion).toMatch(/\d+\.\d+/)
  expect(summary.storage.totalBytes).toBeGreaterThan(0)
  expect(await db().selectFrom('audit_logs').select('id').where('actor_user_id', '=', actor.uid).execute()).toEqual([])
  // withTables 只增加类型，查询仍然经过当前方言；不修改核心迁移清单。
  const migrations = db().withTables<{ nextskin_migration: { name: string; timestamp: string } }>()
  const name = Object.keys(coreMigrations)[0]!
  await migrations.deleteFrom('nextskin_migration').where('name', '=', name).execute()
  await migrations.insertInto('nextskin_migration').values({ name: '9999_future', timestamp: at }).execute()
  try {
    expect((await core.diagnostics.summary(actor)).database).toMatchObject({ pendingCore: 1, unknownCore: 1 })
  } finally {
    await migrations.deleteFrom('nextskin_migration').where('name', '=', '9999_future').execute()
    await migrations.insertInto('nextskin_migration').values({ name, timestamp: at }).execute()
  }
})
test('缺日志或目录不可用时返回空状态；记录核心创建时刻而非请求时刻', async () => {
  const summary = await core.diagnostics.summary(actor)
  expect(summary.storage.droppedRecently).toBeNull()
  expect(summary.jobs.oldestDueAt).toBeNull()
  await rm(directory, { recursive: true })
  expect((await core.diagnostics.summary(actor)).storage).toMatchObject({ freeBytes: null, totalBytes: null })
})
test('诊断包只包含所需文件；机密项同后台判断 isSet，跨 JSON 和日志复用编号，审计带 ip', async () => {
  const set = async (key: CoreSettingKey, value: unknown) =>
    db()
      .insertInto('settings')
      .values({ namespace: 'core', key, value: encodeSettingValue(key, value as never, { secretKey }), updated_at: at })
      .execute()
  await set('mail.smtp', { ...coreSettingsRegistry['mail.smtp'].default, username: 'Person@example.com' })
  await set('mail.smtp.password', 'do-not-export-this-password')
  await set('site.name', '8.8.8.8')
  await db()
    .insertInto('plugins')
    .values({
      id: 'demo',
      version: '1.2.3',
      is_enabled: 1,
      capabilities: '[]',
      package_hash: null,
      last_error: 'load_failed: free text Person@example.com',
      installed_at: at,
      updated_at: at,
    })
    .execute()
  await db()
    .insertInto('failed_jobs')
    .values({
      name: 'core:test',
      payload: '{"password":"never-export-payload"}',
      attempts: 3,
      last_error: 'Person@example.com 8.8.8.8 ' + directory,
      created_at: at,
      failed_at: at,
    })
    .execute()
  await mkdir(join(directory, 'logs'))
  await writeFile(
    join(directory, 'logs', 'nextskin.log'),
    JSON.stringify({
      time: at,
      level: 'info',
      source: 'core',
      msg: 'Person@example.com 8.8.8.8',
      path: directory + '/file',
      password: 'never-export-secret',
    }) +
      '\n' +
      // 字符串里嵌着的 JSON：引号转义过，整行的正则认不出 "token"
      JSON.stringify({ time: at, level: 'warn', source: 'core', msg: '{"token":"never-export-nested-token"}' }) +
      '\n',
  )
  const exported = await core.diagnostics.export(actor)
  expect(exported.filename).toBe('nextskin-diagnostics-20261024T153012Z.zip')
  const files = unzipSync(exported.body)
  expect(Object.keys(files).sort()).toEqual([
    'README.txt',
    'env.json',
    'jobs.json',
    'logs/nextskin.log',
    'plugins.json',
    'settings.json',
    'summary.json',
  ])
  const read = <T = unknown>(name: string): T => JSON.parse(strFromU8(files[name]!)) as T
  const settings = read<Record<string, unknown>>('settings.json')
  expect(Object.keys(settings).sort()).toEqual(Object.keys(coreSettingsRegistry).sort())
  expect(settings['mail.smtp.password']).toEqual({ isSet: true })
  expect(settings['captcha.secretKey']).toEqual({ isSet: false })
  expect(settings['mail.smtp']).toMatchObject({ username: '<邮箱1>' })
  expect(read('env.json')).toEqual({
    names: ['NEXTSKIN_MANAGER_TOKEN', 'NEXTSKIN_SECRET_KEY'],
    database: { dialect: 'sqlite' },
  })
  expect(read<unknown[]>('plugins.json')[0]).toMatchObject({
    id: 'demo',
    lastError: 'load_failed',
    packageMissing: true,
  })
  expect(read<unknown[]>('jobs.json')[0]).toEqual({
    name: 'core:test',
    queued: 0,
    deadLetters: 1,
    lastError: '<邮箱1> <IP1> <实例目录>',
  })
  const logs = strFromU8(files['logs/nextskin.log']!)
  expect(logs).toContain('<邮箱1> <IP1>')
  expect(logs).toContain('<实例目录>/file')
  const all = Object.values(files)
    .map((bytes) => strFromU8(bytes))
    .join('\n')
  for (const raw of [
    'Person@example.com',
    '8.8.8.8',
    directory,
    'do-not-export-this-password',
    'never-export-secret',
    'never-export-payload',
    'never-export-nested-token',
    'free text',
  ])
    expect(all).not.toContain(raw)
  const audit = await db()
    .selectFrom('audit_logs')
    .selectAll()
    .where('actor_user_id', '=', actor.uid)
    .executeTakeFirstOrThrow()
  expect(audit).toMatchObject({
    action: 'diagnostics.export',
    subject_type: 'diagnostics',
    subject_id: 0,
    ip: actor.ip,
  })
})
test('管理进程不可用时没有最近升级结果，待执行插件方法只读取一次，不启动 host', async () => {
  const pendingMigrations = vi.fn().mockResolvedValue([{ plugin: 'demo', migrations: ['0001_first'] }])
  const diagnostics = createDiagnostics({
    db: db(),
    secretKey,
    dataDirectory: directory,
    instanceDirectory: directory,
    runMode: 'manager',
    envNames: [],
    fileLogging: false,
    now: () => timestamp,
    startedAt: at,
    plugins: { ...core.plugins, pendingMigrations },
    updates: core.updates,
  })
  expect((await diagnostics.summary(actor)).database.pendingPlugins).toEqual([{ plugin: 'demo', migrations: 1 }])
  expect(pendingMigrations).toHaveBeenCalledOnce()
})

test('服务端版本查询失败不影响摘要；可用管理进程的最近结果直接复用', async () => {
  vi.spyOn(databaseModule, 'databaseServerVersion').mockRejectedValue(new Error('unavailable'))
  const lastResult = {
    at,
    kind: 'update' as const,
    from: '0.1.0',
    to: '0.2.0',
    result: 'success' as const,
    step: null,
    reason: null,
  }
  const updates = { status: vi.fn().mockResolvedValue({ manager: { available: true, lastResult } }) }
  const diagnostics = createDiagnostics({
    db: db(),
    secretKey,
    dataDirectory: directory,
    instanceDirectory: directory,
    runMode: 'manager',
    envNames: [],
    fileLogging: false,
    now: () => timestamp,
    startedAt: at,
    plugins: core.plugins,
    updates,
  })
  expect(await diagnostics.summary(actor)).toMatchObject({ database: { serverVersion: null }, lastUpdate: lastResult })
})

test('最近 24 小时的丢弃量只扫了最新的 8 MB、还没到 24 小时以前时标成下限', async () => {
  await mkdir(join(directory, 'logs'))
  const newer = (JSON.stringify({ time: at, level: 'info', source: 'core', msg: 'n'.repeat(900) }) + '\n').repeat(
    9 * 1024,
  )
  await writeFile(join(directory, 'logs', 'nextskin.log'), log(LOG_IPC_DROPPED, 123) + '\n' + newer)
  expect((await core.diagnostics.summary(actor)).storage).toMatchObject({
    droppedRecently: 0,
    droppedComplete: false,
  })
})
