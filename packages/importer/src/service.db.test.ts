import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as databases from '@nextskin/db'
import {
  coreMigrations,
  countRows,
  createDatabase,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, removeTestDirectory, type TestDatabase } from '@nextskin/db/testing'
import { createImagePool, DomainError, type ImagePool } from '@nextskin/domain/importer'
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest'
import { createImportService, type ImportService, type ImportServiceOptions, type ImportStartInput } from './service.ts'
import type { SourceDatabase } from './source/schema.ts'
import { createBsSchema, insertRows } from './testing/bs.ts'
import { createEnvironment, missingHash, pngs, SECRET, type Environment } from './testing/fixtures.ts'

let target: TestDatabase<CoreDatabase>
let directory: string
let source: ReturnType<typeof createDatabase<SourceDatabase>>
let env: Environment
let service: ImportService
let input: ImportStartInput
let enter: ReturnType<typeof vi.fn<() => Promise<void>>>
let exit: ReturnType<typeof vi.fn<() => Promise<void>>>
let onImported: ReturnType<typeof vi.fn<() => Promise<void>>>
let logs: MockInstance<typeof console.warn>
const meta = { entry: 'setup', startedBy: null } as const
const salt = 'private-salt-fixture-never-persist'
const password = 'private-database-password-fixture'
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function open(overrides: Partial<ImportServiceOptions> = {}) {
  return createImportService({
    database: target.config,
    textureDirectory: env.storageDirectory,
    secretKey: SECRET,
    maintenance: { enter, exit },
    onImported,
    createImagePool: () => createImagePool({ size: 1 }),
    ...overrides,
  })
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nextskin-import-service-'))
  env = await createEnvironment()
  target = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(target.db, coreMigrations)
  const file = join(directory, 'bs.sqlite')
  source = createDatabase<SourceDatabase>({ dialect: 'sqlite', file })
  await createBsSchema(source, { uuidTable: 'yggdrasil-connect', descriptions: 'new' })
  await insertRows(source, 'options', [{ option_name: 'version', option_value: '6.0.2' }])
  await insertRows(source, 'users', [
    {
      uid: 1,
      email: 'a@example.test',
      nickname: 'A',
      score: 5,
      password: '$2y$10$lkVsMF1jleJ9XJczznXCfOnFkh98MgJbIf6.Z7hDX/LfNN.mW5Qka',
      ip: '',
      last_sign_at: '2020-01-01 00:00:00',
      register_at: '2020-01-01 00:00:00',
    },
  ])
  input = {
    connection: { dialect: 'sqlite', file },
    prefix: '',
    texturesDirectory: env.texturesDirectory,
    timeZone: 'Asia/Shanghai',
    passwordMethod: null,
    salt,
    dryRun: true,
    siteUrl: null,
    uuidOverrides: {},
    replace: false,
    force: false,
  }
  enter = vi.fn().mockResolvedValue(undefined)
  exit = vi.fn().mockResolvedValue(undefined)
  onImported = vi.fn().mockResolvedValue(undefined)
  logs = vi.spyOn(console, 'warn').mockImplementation(() => {})
  service = await open()
})
afterEach(async () => {
  await service?.close()
  await source?.destroy()
  await target?.cleanup()
  await env?.cleanup()
  await removeTestDirectory(directory)
  vi.restoreAllMocks()
})
async function finished(token: string) {
  await vi.waitFor(() => expect(service.maintenance()).toBe(false), { timeout: 15000 })
  return service.run(token)!
}
async function texture(hash = pngs.steve.hash) {
  await insertRows(source, 'textures', [
    { tid: 1, name: 'S', type: 'steve', hash, size: 1, uploader: 1, public: 1, upload_at: '2020-01-01 00:00:00' },
  ])
}

test('启动时把中断的 running 标为失败', async () => {
  await service.close()
  const id = await insertReturningId(target.db, 'import_runs', {
    status: 'running',
    is_dry_run: 0,
    entry: 'admin',
    source: '{}',
    started_at: toIsoTimestamp(new Date()),
  })
  service = await open()
  expect(
    await target.db.selectFrom('import_runs').select(['status', 'finished_at']).where('id', '=', id).executeTakeFirst(),
  ).toMatchObject({ status: 'failed', finished_at: expect.any(String) as unknown })
})

test('维护模式覆盖运行和收尾，只有一个运行；试跑不回调，真实导入回调；令牌轮换和快照隔离', async () => {
  const ending = deferred()
  exit.mockImplementationOnce(() => ending.promise)
  const first = await service.start(input, meta)
  expect(first.state).toMatchObject({ id: null, status: 'running', entry: 'setup', dryRun: true, report: null })
  expect(service.maintenance()).toBe(true)
  expect(enter).toHaveBeenCalledOnce()
  await expect(service.start(input, meta)).rejects.toMatchObject({ code: 'import_running' })
  await expect(service.listRuns(1, 20)).rejects.toMatchObject({ code: 'maintenance' })
  await expect(service.getRun(1)).rejects.toMatchObject({ code: 'maintenance' })
  await expect(service.lastSource()).rejects.toMatchObject({ code: 'maintenance' })
  expect(service.run('wrong')).toBeNull()
  expect(service.cancel('wrong')).toBeNull()
  expect(service.runMarkdown(first.token)).toBeNull()
  const copy = service.run(first.token)!
  copy.progress.rows = 999
  expect(service.run(first.token)!.progress.rows).not.toBe(999)
  try {
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce(), { timeout: 15000 })
    expect(service.maintenance()).toBe(true)
    expect(service.run(first.token)).toMatchObject({ status: 'running', report: null, finishedAt: null })
  } finally {
    ending.resolve()
  }
  const done = await finished(first.token)
  expect(done.status).toBe('succeeded')
  expect(done.finishedAt).not.toBeNull()
  expect(onImported).not.toHaveBeenCalled()
  expect(await countRows(target.db.selectFrom('users'))).toBe(0)
  expect(service.runMarkdown(first.token)).toContain('6.0.2')
  expect(() => service.cancel(first.token)).toThrow(expect.objectContaining({ code: 'import_not_running' }))
  const second = await service.start({ ...input, dryRun: false }, { entry: 'admin', startedBy: 'owner@example.test' })
  expect(service.run(first.token)).toBeNull()
  expect(service.runMarkdown(first.token)).toBeNull()
  expect((await finished(second.token)).status).toBe('succeeded')
  expect(onImported).toHaveBeenCalledOnce()
  expect(await countRows(target.db.selectFrom('users'))).toBe(1)
  const serialized =
    JSON.stringify(service.run(second.token)) +
    JSON.stringify(await target.db.selectFrom('import_runs').selectAll().execute()) +
    JSON.stringify(logs.mock.calls)
  expect(serialized).not.toContain(salt)
  expect(serialized).not.toContain(password)
})

test('在事务里取消后回滚，进度带当前阶段 total，关闭每次运行的图像池', async () => {
  await service.close()
  await texture()
  const reached = deferred(),
    release = deferred()
  const pool = createImagePool({ size: 1 })
  const inspect = pool.inspect.bind(pool)
  const close = vi.spyOn(pool, 'close')
  pool.inspect = async (value) => {
    reached.resolve()
    await release.promise
    return inspect(value)
  }
  service = await open({ createImagePool: () => pool })
  const first = await service.start({ ...input, dryRun: false }, meta)
  await reached.promise
  expect(service.run(first.token)?.progress).toMatchObject({ stage: 'textures', total: 1, rows: 0 })
  expect(service.cancel(first.token)).toMatchObject({ cancelling: true })
  release.resolve()
  expect((await finished(first.token)).status).toBe('cancelled')
  expect(await countRows(target.db.selectFrom('users'))).toBe(0)
  expect(close).toHaveBeenCalledOnce()
  expect(onImported).not.toHaveBeenCalled()
})

test('检查旧库结构、计数和材质抽样；坏前缀、打不开文件、读不了目录和缺文件', async () => {
  await texture(missingHash)
  expect(await service.check(input)).toEqual({
    database: {
      status: 'ok',
      bsVersion: '6.0.2',
      counts: { users: 1, players: 0, textures: 1 },
      uuidTable: 'yggdrasil-connect',
      descriptions: true,
      unknownTables: [],
    },
    textures: { readable: true, sampled: 1, missing: 1 },
  })
  expect((await service.check({ ...input, prefix: 'bad_' })).database).toEqual({
    status: 'not_blessing_skin',
    detail: 'bad_users',
  })
  await source.schema.alterTable('users').dropColumn('nickname').execute()
  expect((await service.check(input)).database).toEqual({ status: 'not_blessing_skin', detail: 'users.nickname' })
  expect(
    (await service.check({ ...input, connection: { dialect: 'sqlite', file: join(directory, 'missing.sqlite') } }))
      .database,
  ).toEqual({ status: 'unreachable', detail: null })
  expect((await service.check({ ...input, texturesDirectory: join(directory, 'missing') })).textures.readable).toBe(
    false,
  )
})

test('检查连接错误按错误码分类，detail 从不携带驱动消息', async () => {
  const spy = vi.spyOn(databases, 'readSnapshot')
  for (const [fields, status] of [
    [{ code: 'ECONNREFUSED' }, 'unreachable'],
    [{ code: 'ENOTFOUND' }, 'unreachable'],
    [{ errno: 1045 }, 'auth_failed'],
    [{ code: '28P01' }, 'auth_failed'],
    [{ sqlState: '28000' }, 'auth_failed'],
    [{ errno: 1049 }, 'database_missing'],
    [{ code: '3D000' }, 'database_missing'],
    [{ code: 'XX000' }, 'failed'],
  ] as const) {
    spy.mockRejectedValueOnce(Object.assign(new Error(password), fields))
    expect((await service.check(input)).database).toEqual({ status, detail: null })
  }
})

test.each([
  ['timeZone', 'bad-zone', 'import_timezone_invalid'],
  ['passwordMethod', 'bad-method', 'import_password_method_invalid'],
  ['siteUrl', 'ftp://a.test', 'import_site_url_invalid'],
  ['texturesDirectory', '/nextskin-test-does-not-exist', 'import_textures_unreadable'],
] as const)('参数错误映射到字段：%s', async (field, value, code) => {
  await expect(service.start({ ...input, [field]: value }, meta)).rejects.toMatchObject({ code, fields: [field] })
  expect(service.maintenance()).toBe(false)
  expect(enter).not.toHaveBeenCalled()
  expect(await countRows(target.db.selectFrom('import_runs'))).toBe(0)
})

test('路径必须绝对；check 单独验证时区和密码算法', async () => {
  for (const operation of [
    (value: ImportStartInput) => service.check(value),
    (value: ImportStartInput) => service.start(value, meta),
  ]) {
    await expect(
      operation({ ...input, connection: { dialect: 'sqlite', file: 'relative.sqlite' } }),
    ).rejects.toMatchObject({ code: 'invalid_request', fields: ['connection'] })
    await expect(operation({ ...input, texturesDirectory: 'relative' })).rejects.toMatchObject({
      code: 'invalid_request',
      fields: ['texturesDirectory'],
    })
  }
  await expect(service.check({ ...input, timeZone: 'wrong' })).rejects.toMatchObject({
    code: 'import_timezone_invalid',
  })
  await expect(service.check({ ...input, passwordMethod: 'wrong' })).rejects.toMatchObject({
    code: 'import_password_method_invalid',
  })
})

test('没有旧站根目录时不解析相对路径，绝对路径和网络连接仍可用', () => {
  const text = 'DB_CONNECTION=sqlite\nDB_DATABASE=database/bs.sqlite\nTEXTURES_DIR=storage/textures'
  expect(service.parseEnv(text, null)).toMatchObject({ connection: null, texturesDirectory: null })
  expect(service.parseEnv(text, 'relative')).toMatchObject({ connection: null, texturesDirectory: null })
  expect(service.parseEnv(text, directory)).toMatchObject({
    connection: { dialect: 'sqlite', file: join(directory, 'database/bs.sqlite') },
    texturesDirectory: join(directory, 'storage/textures'),
  })
  expect(
    service.parseEnv(
      `DB_CONNECTION=sqlite\nDB_DATABASE=${join(directory, 'bs.sqlite')}\nTEXTURES_DIR=${directory}`,
      null,
    ),
  ).toMatchObject({ connection: input.connection, texturesDirectory: directory })
  expect(service.parseEnv('DB_CONNECTION=pgsql\nDB_DATABASE=bs\nDB_PASSWORD=pass\nSALT=pepper', null)).toMatchObject({
    connection: { dialect: 'postgres', password: 'pass' },
    salt: 'pepper',
    texturesDirectory: null,
  })
})

test('列表分页、报告下载、最后一次非机密来源，以及坏报告 JSON', async () => {
  expect(await service.lastSource()).toBeNull()
  const first = await service.start(input, meta)
  await finished(first.token)
  const second = await service.start(input, meta)
  const state = await finished(second.token)
  const page = await service.listRuns(1, 1)
  expect(page.total).toBe(2)
  expect(page.runs[0]).toMatchObject({
    id: state.id,
    status: 'succeeded',
    dryRun: true,
    entry: 'setup',
    startedBy: null,
    totals: { users: 1, players: 0, textures: 0, blocking: 0 },
    error: null,
  })
  expect((await service.listRuns(2, 1)).runs[0]?.id).toBeLessThan(state.id!)
  expect(await service.lastSource()).toEqual({
    connection: input.connection,
    prefix: '',
    texturesDirectory: input.texturesDirectory,
    timeZone: input.timeZone,
  })
  expect((await service.getRun(state.id!))?.report).toEqual(state.report)
  expect(await service.runMarkdownById(state.id!)).toBe(service.runMarkdown(second.token))
  expect(await service.getRun(state.id! + 1)).toBeNull()
  expect(await service.runMarkdownById(state.id! + 1)).toBeNull()
  await target.db.updateTable('import_runs').set({ report: '{broken' }).where('id', '=', state.id!).execute()
  expect((await service.getRun(state.id!))?.report).toBeNull()
  expect((await service.getRun(state.id!))?.run.totals).toBeNull()
  expect(await service.runMarkdownById(state.id!)).toBeNull()
})

test('维护入口失败可重试；引擎在创建记录前失败也清理维护和图像池', async () => {
  enter.mockRejectedValueOnce(new Error('enter failed'))
  await expect(service.start(input, meta)).rejects.toThrow('enter failed')
  expect(service.maintenance()).toBe(false)
  expect(exit).toHaveBeenCalledOnce()
  exit.mockClear()
  await service.close()
  const close = vi.fn().mockResolvedValue(undefined)
  const pool = { close } as unknown as ImagePool
  service = await open({ createImagePool: () => pool })
  await target.db.schema.dropTable('import_runs').execute()
  const run = await service.start(input, meta)
  expect((await finished(run.token)).status).toBe('failed')
  expect(service.run(run.token)?.report).toBeNull()
  expect(exit).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
  expect(JSON.stringify(logs.mock.calls)).not.toContain(salt)
})

test('网络连接的密码不进入 state、报告、运行行或日志；onImported 失败只记异常类型', async () => {
  const run = await service.start(
    {
      ...input,
      connection: { dialect: 'postgres', host: '127.0.0.1', port: 1, database: 'bs', username: 'u', password },
    },
    meta,
  )
  expect((await finished(run.token)).status).toBe('failed')
  const serialized =
    JSON.stringify(service.run(run.token)) +
    JSON.stringify(await target.db.selectFrom('import_runs').selectAll().execute()) +
    JSON.stringify(logs.mock.calls)
  expect(serialized).not.toContain(password)
  expect(serialized).not.toContain(salt)
  onImported.mockRejectedValueOnce(new Error(password))
  const real = await service.start({ ...input, dryRun: false }, meta)
  expect((await finished(real.token)).status).toBe('succeeded')
  expect(logs).toHaveBeenCalledWith('[import] Error')
})

test('close 会取消并等待运行结束，再关闭连接', async () => {
  const run = await service.start(input, meta)
  await service.close()
  expect(service.maintenance()).toBe(false)
  expect(service.run(run.token)?.status).toBe('cancelled')
})

test('enter 出错后尽力退出维护，保留原来的领域错误；退出失败只记录异常类型', async () => {
  const error = new DomainError('import_jobs_busy')
  enter.mockRejectedValueOnce(error)
  exit.mockRejectedValueOnce(new Error(password))
  await expect(service.start(input, meta)).rejects.toBe(error)
  expect(exit).toHaveBeenCalledOnce()
  expect(service.maintenance()).toBe(false)
  expect(await countRows(target.db.selectFrom('import_runs'))).toBe(0)
  expect(logs).toHaveBeenCalledExactlyOnceWith('[import] Error')
  expect(JSON.stringify(logs.mock.calls)).not.toContain(password)
  const run = await service.start(input, meta)
  expect((await finished(run.token)).status).toBe('succeeded')
})

test('exit 失败仍公布结果并退出维护，日志提示重启且不带异常消息', async () => {
  exit.mockRejectedValueOnce(new Error(password))
  const run = await service.start(input, meta)
  expect((await finished(run.token)).status).toBe('succeeded')
  expect(service.maintenance()).toBe(false)
  expect(logs).toHaveBeenCalledWith('[import] Error')
  expect(logs).toHaveBeenCalledWith('[import] 后台任务可能仍处于暂停状态，请重启服务')
  expect(JSON.stringify(logs.mock.calls)).not.toContain(password)
})
