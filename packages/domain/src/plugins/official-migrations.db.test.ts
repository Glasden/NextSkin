import { mkdtemp, readdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import {
  coreMigrations,
  MigrationBackupError,
  migrateToLatest,
  toIsoTimestamp,
  withExclusiveLock,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, removeTestDirectory, type TestDatabase } from '@nextskin/db/testing'
import { discardLogger, captureLogs } from '@nextskin/logging'
import { definePlugin, table } from '@nextskin/plugin-sdk'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { coreConfigFromEnv, openCore } from '../bootstrap.ts'
import type { CoreConfig } from '../config.ts'
import { official } from './plugins.test-helper.ts'
import type { OfficialPlugin } from './system.ts'

let database: TestDatabase<CoreDatabase>
let config: CoreConfig
let directory: string
let opened: Awaited<ReturnType<typeof openCore>>[]
const timestamp = toIsoTimestamp(new Date('2026-10-20T12:00:00Z'))
const last = Object.keys(coreMigrations).sort().at(-1)!

let logs: ReturnType<typeof captureLogs>
beforeEach(async () => {
  database = await createTestDatabase<CoreDatabase>()
  directory = await mkdtemp(join(tmpdir(), 'nextskin-official-migrations-'))
  config = coreConfigFromEnv({ NEXTSKIN_DATA_DIR: directory }, { cwd: directory, production: false })
  config.database = database.config
  opened = []
  logs = captureLogs()
})
afterEach(async () => {
  logs.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
  try {
    for (const item of opened) await item.close()
  } finally {
    await database.cleanup()
    await removeTestDirectory(directory)
  }
})

function plugin(id = 'a', up: () => Promise<void> = async () => {}) {
  const first = vi.fn(async () => {})
  const second = vi.fn(async () => {
    await up()
  })
  return {
    first,
    second,
    official: official(
      id,
      definePlugin({ capabilities: ['storage.tables'], migrations: { '001': { up: first }, '002': { up: second } } }),
    ),
  }
}

async function seed(id: string, enabled = true) {
  await database.db
    .insertInto('plugins')
    .values({
      id,
      version: '1.0.0',
      is_enabled: enabled ? 1 : 0,
      capabilities: '[]',
      installed_at: timestamp,
      updated_at: timestamp,
    })
    .execute()
  await database.db
    .insertInto('plugin_migrations')
    .values({ plugin_id: id, name: '001', executed_at: timestamp })
    .execute()
}

async function boot(officialPlugins: OfficialPlugin[]) {
  const result = await openCore(config, { startJobs: false, officialPlugins, pluginLogger: discardLogger })
  opened.push(result)
  return result
}

async function recorded(id = 'a') {
  return (
    await database.db
      .selectFrom('plugin_migrations')
      .select('name')
      .where('plugin_id', '=', id)
      .orderBy('name')
      .execute()
  ).map((row) => row.name)
}

async function init(previous = false) {
  await migrateToLatest(
    database.db,
    previous ? Object.fromEntries(Object.entries(coreMigrations).filter(([name]) => name !== last)) : coreMigrations,
  )
}

test('打开核心先执行已启用官方插件的新迁移，未启用和安装插件不执行，再次打开报告为空', async () => {
  await init()
  await seed('a')
  await seed('disabled', false)
  await seed('installed')
  const changed = vi.fn(async () => {})
  const first = vi.fn(async () => {})
  const a = official(
    'a',
    definePlugin({
      capabilities: ['storage.tables'],
      tables: { records: table<{ value: string }>() },
      migrations: {
        '001': { up: first },
        '002': {
          up: async (db) => {
            // eslint-disable-next-line nextskin/no-dialect-specific-sql -- 插件迁移使用远程 Kysely，由网关处理方言。
            await db.schema
              .createTable('records')
              .addColumn('value', 'varchar(128)', (c) => c.notNull())
              .execute()
            await changed()
          },
        },
      },
    }),
  )
  const disabled = plugin('disabled')
  const result = await boot([disabled.official, a])
  expect(result.migrations.core).toEqual([])
  expect(result.migrations.plugins).toEqual([{ plugin: 'a', migrations: ['002'] }])
  expect(changed).toHaveBeenCalledOnce()
  expect(first).not.toHaveBeenCalled()
  expect(disabled.second).not.toHaveBeenCalled()
  expect(await recorded()).toEqual(['001', '002'])
  expect(await recorded('installed')).toEqual(['001'])
  expect(await recorded('disabled')).toEqual(['001'])
  expect(
    await database.db
      .withTables<{ p_a__records: { value: string } }>()
      .selectFrom('p_a__records')
      .selectAll()
      .execute(),
  ).toEqual([])
  await result.close()
  opened.pop()
  const again = await boot([a, disabled.official])
  expect(again.migrations).toEqual({ core: [], plugins: [], backup: null })
})

test('只有未启用的官方插件有待执行迁移时不备份', async () => {
  await init()
  await seed('a', false)
  const a = plugin()
  expect((await boot([a.official])).migrations).toEqual({ core: [], plugins: [], backup: null })
  expect(a.second).not.toHaveBeenCalled()
  await expect(readdir(config.backupDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('只有插件迁移时按 id 排序取 label，在迁移之前备份，报告绝对路径', async () => {
  if (database.config.dialect !== 'sqlite') return
  await init()
  await seed('z')
  await seed('a')
  let backupFile: string | undefined
  const a = plugin('a', async () => {
    const files = await readdir(config.backupDirectory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^nextskin-\d{8}T\d{6}Z-a-002\.sqlite$/)
    backupFile = join(config.backupDirectory, files[0]!)
    const snapshot = new DatabaseSync(backupFile, { readOnly: true })
    try {
      expect(snapshot.prepare('select plugin_id, name from plugin_migrations order by plugin_id').all()).toEqual([
        { plugin_id: 'a', name: '001' },
        { plugin_id: 'z', name: '001' },
      ])
    } finally {
      snapshot.close()
    }
  })
  const result = await boot([plugin('z').official, a.official])
  expect(result.migrations.backup).toBe(backupFile)
  expect(isAbsolute(result.migrations.backup!)).toBe(true)
  expect(result.migrations.plugins).toEqual([
    { plugin: 'a', migrations: ['002'] },
    { plugin: 'z', migrations: ['002'] },
  ])
})

test('核心和插件都有迁移时只备份一次，插件失败后重试沿用核心迁移前的备份', async () => {
  if (database.config.dialect !== 'sqlite') return
  await init(true)
  await seed('a')
  const a = plugin('a', () => Promise.reject(new Error('failure')))
  await expect(boot([a.official])).rejects.toThrow('插件 a 迁移 002 执行失败')
  const files = await readdir(config.backupDirectory)
  expect(files).toHaveLength(1)
  expect(files[0]).toContain(last)
  a.second.mockResolvedValue(undefined)
  const result = await boot([a.official])
  expect(result.migrations).toEqual({
    core: [],
    plugins: [{ plugin: 'a', migrations: ['002'] }],
    backup: join(config.backupDirectory, files[0]!),
  })
  expect(await readdir(config.backupDirectory)).toEqual(files)
})

test('核心和插件都有迁移时报告两者，备份保留核心迁移前的记录', async () => {
  await init(true)
  await seed('a')
  const result = await boot([plugin().official])
  expect(result.migrations.core).toEqual([last])
  expect(result.migrations.plugins).toEqual([{ plugin: 'a', migrations: ['002'] }])
  if (database.config.dialect === 'sqlite') {
    expect(await readdir(config.backupDirectory)).toEqual([basename(result.migrations.backup!)])
    const snapshot = new DatabaseSync(result.migrations.backup!, { readOnly: true })
    try {
      expect(snapshot.prepare('select name from nextskin_migration where name = ?').all(last)).toEqual([])
      expect(snapshot.prepare('select name from plugin_migrations').all()).toEqual([{ name: '001' }])
    } finally {
      snapshot.close()
    }
  } else expect(result.migrations.backup).toBeNull()
})

test('插件迁移失败阻止打开核心，只暴露插件和迁移名，cause 保留原异常，last_error 脱敏', async () => {
  await init()
  await seed('a')
  const cause = new Error('postgres://user:private-password@database/site')
  const a = plugin('a', () => Promise.reject(cause))
  const failure: unknown = await boot([a.official]).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe('插件 a 迁移 002 执行失败')
  expect((failure as Error).cause).toMatchObject({ cause })
  expect(await recorded()).toEqual(['001'])
  expect(
    await database.db.selectFrom('plugins').select('last_error').where('id', '=', 'a').executeTakeFirstOrThrow(),
  ).toEqual({ last_error: 'migration_failed: 插件 a 迁移 002 执行失败' })
})

test('插件迁移的备份失败一分钟内复用错误，之后恢复；成功的备份在迁移失败后仍复用', async () => {
  if (database.config.dialect !== 'sqlite') return
  await init()
  await seed('a')
  await writeFile(config.backupDirectory, '')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(timestamp)
  const a = plugin('a', () => Promise.reject(new Error('failure')))
  const failure: unknown = await boot([a.official]).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(MigrationBackupError)
  expect(a.second).not.toHaveBeenCalled()
  await unlink(config.backupDirectory)
  vi.setSystemTime(new Date(timestamp).getTime() + 59_999)
  await expect(boot([a.official])).rejects.toBe(failure)
  expect(await recorded()).toEqual(['001'])
  vi.setSystemTime(new Date(timestamp).getTime() + 60_000)
  await expect(boot([a.official])).rejects.toThrow('插件 a 迁移 002 执行失败')
  const files = await readdir(config.backupDirectory)
  vi.setSystemTime(new Date(timestamp).getTime() + 120_000)
  a.second.mockResolvedValue(undefined)
  expect((await boot([a.official])).migrations.backup).toBe(join(config.backupDirectory, files[0]!))
  expect(await readdir(config.backupDirectory)).toEqual(files)
})

test('并发打开核心时短暂等待插件锁，持锁者完成后重读记录，不重复迁移或备份', async () => {
  await init()
  await seed('a')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = withExclusiveLock(database.db, 'nextskin:plugin:a', async () => {
    entered.resolve()
    await release.promise
    await database.db
      .insertInto('plugin_migrations')
      .values({ plugin_id: 'a', name: '002', executed_at: timestamp })
      .execute()
  })
  await entered.promise
  const a = plugin()
  const opening = boot([a.official])
  void opening.catch(() => {})
  try {
    await delay(650)
  } finally {
    release.resolve()
  }
  await held
  expect((await opening).migrations).toEqual({ core: [], plugins: [], backup: null })
  expect(a.second).not.toHaveBeenCalled()
})

test('插件锁一直被占用时有限重试后让核心打开失败', async () => {
  await init()
  await seed('a')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = withExclusiveLock(database.db, 'nextskin:plugin:a', async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const a = plugin()
  try {
    await expect(boot([a.official])).rejects.toMatchObject({ code: 'plugin_busy' })
    expect(a.second).not.toHaveBeenCalled()
  } finally {
    release.resolve()
    await held
  }
})

test('插件部分迁移成功后失败，剩余迁移重试仍沿用整批开始前的备份', async () => {
  if (database.config.dialect !== 'sqlite') return
  await init()
  await seed('a')
  const second = vi.fn(async () => {})
  const third = vi.fn<() => Promise<void>>(() => Promise.reject(new Error('failure')))
  const a = official(
    'a',
    definePlugin({
      capabilities: ['storage.tables'],
      migrations: { '001': { up: async () => {} }, '002': { up: second }, '003': { up: third } },
    }),
  )
  await expect(boot([a])).rejects.toThrow('插件 a 迁移 003 执行失败')
  expect(await recorded()).toEqual(['001', '002'])
  const files = await readdir(config.backupDirectory)
  expect(files).toHaveLength(1)
  third.mockResolvedValue(undefined)
  const result = await boot([a])
  expect(result.migrations.plugins).toEqual([{ plugin: 'a', migrations: ['003'] }])
  expect(result.migrations.backup).toBe(join(config.backupDirectory, files[0]!))
  expect(await readdir(config.backupDirectory)).toEqual(files)
  expect(second).toHaveBeenCalledOnce()
  const snapshot = new DatabaseSync(result.migrations.backup!, { readOnly: true })
  try {
    expect(snapshot.prepare('select name from plugin_migrations').all()).toEqual([{ name: '001' }])
  } finally {
    snapshot.close()
  }
})
