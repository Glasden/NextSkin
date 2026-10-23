import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coreMigrations, createDatabase, migrateToLatest, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import { removeTestDirectory } from '@nextskin/db/testing'
import { OfficialPluginMigrationError, openCore } from '@nextskin/domain'
import { coreConfigFromEnv } from '@nextskin/domain/config'
import { officialPlugins } from '@nextskin/official-plugins'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ConfigError } from '../config.ts'
import type { CommandContext } from '../context.ts'
import { run } from './migrate.ts'

const { up } = vi.hoisted(() => ({ up: vi.fn<() => Promise<void>>() }))
vi.mock('@nextskin/official-plugins', () => ({
  officialPlugins: [
    {
      package: { name: '@test/migrate', version: '1.0.0', nextskin: { id: 'test-migrate' } },
      definition: { capabilities: ['storage.tables'], migrations: { '001': { up: async () => {} }, '002': { up } } },
      messages: { 'zh-CN': {}, en: {} },
    },
  ],
}))
vi.mock('@nextskin/domain', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nextskin/domain')>()
  return { ...original, openCore: vi.fn(original.openCore) }
})

let context: CommandContext
let db: ReturnType<typeof createDatabase<CoreDatabase>>
const last = Object.keys(coreMigrations).sort().at(-1)!
const output: string[] = []
const errors: string[] = []
let savedLog: typeof console.log
let savedInfo: typeof console.info
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-migrate-'))
  const config = coreConfigFromEnv({ NEXTSKIN_DATA_DIR: root }, { cwd: root, production: false })
  context = {
    root,
    cwd: root,
    source: true,
    production: false,
    version: '0.0.0',
    config,
    env: {},
    host: '127.0.0.1',
    port: 3000,
  }
  db = createDatabase<CoreDatabase>(config.database)
  output.length = errors.length = 0
  savedLog = vi.spyOn(console, 'log').mockImplementation((line: string) => {
    output.push(line)
  })
  savedInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation((line: string) => {
    errors.push(line)
  })
  up.mockReset().mockResolvedValue(undefined)
  vi.mocked(openCore).mockClear()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await db.destroy()
  await removeTestDirectory(context.root)
})
const read = () => Promise.resolve(context)
async function seed(pendingCore = false, enabled = true) {
  await migrateToLatest(
    db,
    Object.fromEntries(Object.entries(coreMigrations).filter(([name]) => !pendingCore || name !== last)),
  )
  const timestamp = toIsoTimestamp(new Date())
  for (const [id, is_enabled] of [
    ['test-migrate', enabled ? 1 : 0],
    ['installed', 1],
  ] as const) {
    await db
      .insertInto('plugins')
      .values({ id, version: '1.0.0', is_enabled, capabilities: '[]', installed_at: timestamp, updated_at: timestamp })
      .execute()
  }
  await db
    .insertInto('plugin_migrations')
    .values({ plugin_id: 'test-migrate', name: '001', executed_at: timestamp })
    .execute()
}

for (const json of [false, true]) {
  test(`执行核心和已启用官方插件迁移、报告备份，json=${json}`, async () => {
    await seed(true)
    if (json)
      up.mockImplementation(() => {
        console.log('迁移日志')
        console.info('迁移提示')
        return Promise.resolve()
      })
    expect(await run(json ? ['--json'] : [], read)).toBe(0)
    const call = vi.mocked(openCore).mock.calls[0]!
    expect(call).toEqual([
      context.config,
      {
        startJobs: false,
        officialPlugins,
        pluginLog: expect.any(Function) as unknown,
        migrationReport: expect.any(Object) as unknown,
      },
    ])
    expect(up).toHaveBeenCalledOnce()
    expect(await migrateToLatest(db, coreMigrations)).toEqual([])
    expect(
      await db
        .selectFrom('plugin_migrations')
        .select('name')
        .where('plugin_id', '=', 'test-migrate')
        .orderBy('name')
        .execute(),
    ).toEqual([{ name: '001' }, { name: '002' }])
    if (json) {
      expect(output).toHaveLength(1)
      const report = JSON.parse(output[0]!) as Awaited<ReturnType<typeof openCore>>['migrations']
      expect(report).toEqual({
        core: [last],
        plugins: [{ plugin: 'test-migrate', migrations: ['002'] }],
        backup: expect.any(String) as unknown,
      })
      expect((await readFile(report.backup!)).length).toBeGreaterThan(0)
      expect(errors.join('\n')).toContain('已先把数据库备份到')
      expect(errors).toContain('迁移日志')
      expect(errors).toContain('迁移提示')
    } else {
      expect(output).toEqual([
        `[nextskin] 已执行迁移 ${last}`,
        '[nextskin] 已执行插件 test-migrate 的迁移 002',
        expect.stringContaining('[nextskin] 迁移之前已备份数据库到 '),
      ])
    }
    call[1]!.pluginLog!('插件日志')
    expect(errors).toContain('插件日志')
    expect(console.log).toBe(savedLog)
    expect(console.info).toBe(savedInfo)
    output.length = 0
    expect(await run(json ? ['--json'] : [], read)).toBe(0)
    expect(output).toEqual([
      json ? JSON.stringify({ core: [], plugins: [], backup: null }) : '[nextskin] 没有要执行的迁移',
    ])
  })
}

test('只迁移官方插件也报告 SQLite 备份；停用的插件不迁移', async () => {
  await seed(false, false)
  expect(await run(['--json'], read)).toBe(0)
  expect(JSON.parse(output[0]!)).toEqual({ core: [], plugins: [], backup: null })
  expect(up).not.toHaveBeenCalled()
  await db.updateTable('plugins').set({ is_enabled: 1 }).where('id', '=', 'test-migrate').execute()
  output.length = 0
  expect(await run(['--json'], read)).toBe(0)
  expect(JSON.parse(output[0]!)).toEqual({
    core: [],
    plugins: [{ plugin: 'test-migrate', migrations: ['002'] }],
    backup: expect.any(String) as unknown,
  })
})

test.each([false, true])('升级前备份失败安全输出，json=%s', async (json) => {
  await seed(true)
  await writeFile(context.config.backupDirectory, '')
  expect(await run(json ? ['--json'] : [], read)).toBe(1)
  const message = `迁移前备份数据库失败：没法写入 ${context.config.backupDirectory}；没有执行迁移。请检查数据目录的剩余空间和权限后重试`
  if (json)
    expect(JSON.parse(output[0]!)).toEqual({ error: { kind: 'backup', message }, core: [], plugins: [], backup: null })
  else {
    expect(errors).toEqual([`[nextskin] ${message}`])
    expect(output).toEqual([])
  }
  expect(up).not.toHaveBeenCalled()
  expect(await migrateToLatest(db, coreMigrations)).toEqual([last])
  expect(console.log).toBe(savedLog)
  expect(console.info).toBe(savedInfo)
})

test.each([false, true])('官方插件迁移失败只回显插件和迁移名，json=%s', async (json) => {
  await seed()
  up.mockRejectedValue(new Error('postgres://user:private@db/site'))
  expect(await run(json ? ['--json'] : [], read)).toBe(1)
  const message = '插件 test-migrate 迁移 002 执行失败'
  if (json)
    expect(JSON.parse(output[0]!)).toEqual({
      error: { kind: 'migration', message },
      core: [],
      plugins: [],
      backup: expect.any(String) as unknown,
    })
  else expect(errors).toContain(`[nextskin] ${message}`)
  expect(errors.join('')).not.toContain('private')
  await expect(vi.mocked(openCore).mock.results[0]!.value).rejects.toBeInstanceOf(OfficialPluginMigrationError)
})

test.each([false, true])('其他异常不回显原文，json=%s', async (json) => {
  vi.mocked(openCore).mockRejectedValueOnce(new Error('mysql://user:private@db/site'))
  expect(await run(json ? ['--json'] : [], read)).toBe(1)
  const message = '执行迁移失败；请检查数据库配置、连接和权限。'
  expect(json ? output : errors).toEqual([
    json
      ? JSON.stringify({ error: { kind: 'migration', message }, core: [], plugins: [], backup: null })
      : `[nextskin] ${message}`,
  ])
  expect(console.log).toBe(savedLog)
  expect(console.info).toBe(savedInfo)
})

test('迁移成功后关闭核心失败，照样报告成功', async () => {
  const opened = await openCore(context.config, { startJobs: false })
  const close = vi.fn(async () => {
    await opened.close()
    throw new Error('private')
  })
  vi.mocked(openCore).mockResolvedValueOnce({ ...opened, close })
  expect(await run(['--json'], read)).toBe(0)
  expect(close).toHaveBeenCalledOnce()
  expect(output).toEqual([JSON.stringify(opened.migrations)])
})

test.each([[[]], [['--json']]])('配置错误仍抛给 main，参数=%j', async (argv) => {
  const failure = new ConfigError('配置有错')
  await expect(run(argv, () => Promise.reject(failure))).rejects.toBe(failure)
  expect(output).toEqual([])
  expect(console.log).toBe(savedLog)
  expect(console.info).toBe(savedInfo)
})

test.each([['--help'], ['-h'], ['--unknown'], ['extra'], ['--json', '--unknown']])(
  '检查参数先于配置：%j',
  async (...argv) => {
    const read = vi.fn(() => Promise.reject(new ConfigError('不应读取配置')))
    const help = argv[0] === '--help' || argv[0] === '-h'
    expect(await run(argv, read)).toBe(help ? 0 : 1)
    expect(help ? output : errors).toEqual(['用法：nextskin migrate [--json]'])
    expect(read).not.toHaveBeenCalled()
  },
)

test('核心已提交而官方插件迁移失败时，JSON 保留核心迁移和原始备份', async () => {
  await seed(true)
  up.mockRejectedValue(new Error('plugin migration failed'))
  expect(await run(['--json'], read)).toBe(1)
  const report = JSON.parse(output[0]!) as {
    core: string[]
    backup: string
    plugins: unknown[]
    error: { kind: string }
  }
  expect(report).toMatchObject({ core: [last], plugins: [], error: { kind: 'migration' } })
  expect((await readFile(report.backup)).length).toBeGreaterThan(0)
  expect(await migrateToLatest(db, coreMigrations)).toEqual([])
  expect(output).toHaveLength(1)
})
