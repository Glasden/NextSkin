import { mkdtemp, readdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { coreMigrations, createDatabase, migrateToLatest, type CoreDatabase } from '@nextskin/db'
import { removeTestDirectory } from '@nextskin/db/testing'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { coreConfigFromEnv, migrateCore, openCore, type MigrationReport } from './bootstrap.ts'
import type { CoreConfig } from './config.ts'
import { MigrationBackupError } from './index.ts'

const names = Object.keys(coreMigrations).sort()
const last = names.at(-1)!
const previous = Object.fromEntries(Object.entries(coreMigrations).filter(([name]) => name !== last))
let directory: string
let config: CoreConfig
let db: Kysely<CoreDatabase>

beforeEach(async () => {
  // 每个用例使用不同的源库路径，隔离 globalThis 上的进程级备份记录。
  directory = await mkdtemp(join(tmpdir(), 'nextskin-core-backup-'))
  config = coreConfigFromEnv({ NEXTSKIN_DATA_DIR: directory }, { cwd: directory, production: false })
  db = createDatabase<CoreDatabase>(config.database)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  try {
    await db.destroy()
  } finally {
    await removeTestDirectory(directory)
  }
})

async function executed(): Promise<string[]> {
  const rows = await db
    .withTables<{ nextskin_migration: { name: string } }>()
    .selectFrom('nextskin_migration')
    .select('name')
    .orderBy('name')
    .execute()
  return rows.map((row) => row.name)
}

test('已有核心迁移时先备份再升级，备份中的迁移记录停在升级之前', async () => {
  await migrateToLatest(db, previous)
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const onBackup = vi.fn()
  expect(await migrateCore(db, config, { onBackup })).toEqual([last])
  const files = await readdir(config.backupDirectory)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(new RegExp(`^nextskin-\\d{8}T\\d{6}Z-${last}\\.sqlite$`))
  const file = join(config.backupDirectory, files[0]!)
  expect(onBackup).toHaveBeenCalledExactlyOnceWith(file)
  const backup = new DatabaseSync(file, { readOnly: true })
  try {
    expect(backup.prepare('select name from nextskin_migration order by name').all()).toEqual(
      names.slice(0, -1).map((name) => ({ name })),
    )
  } finally {
    backup.close()
  }
  expect(await executed()).toEqual(names)
  expect(info).toHaveBeenCalledExactlyOnceWith(`[nextskin] 有 1 个迁移要执行，已先把数据库备份到 ${file}`)
  expect(await migrateCore(db, config)).toEqual([])
  expect(await readdir(config.backupDirectory)).toEqual(files)
  expect(info).toHaveBeenCalledOnce()
})

test('全新的库直接执行核心迁移，不产生备份目录', async () => {
  expect(await migrateCore(db, config)).toEqual(names)
  await expect(readdir(config.backupDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('内存库配置跳过文件备份，仍执行待执行的迁移', async () => {
  // 默认 WAL 方言拒绝内存库；用已有文件库验证 migrateCore 对 :memory: 配置的分支。
  await migrateToLatest(db, previous)
  config.database = { dialect: 'sqlite', file: ':memory:' }
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  expect(await migrateCore(db, config)).toEqual([last])
  expect(await executed()).toEqual(names)
  await expect(readdir(config.backupDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(info).not.toHaveBeenCalled()
})

test('备份失败时原样抛出备份错误，原库不执行最后一个核心迁移', async () => {
  await migrateToLatest(db, previous)
  await writeFile(config.backupDirectory, '')
  await expect(migrateCore(db, config)).rejects.toBeInstanceOf(MigrationBackupError)
  expect(await executed()).toEqual(names.slice(0, -1))
})

test('迁移本身失败后重新打开数据库，仍沿用同一份备份', async () => {
  await migrateToLatest(db, previous)
  const failure = new Error('模拟核心迁移失败')
  const migration = vi.spyOn(coreMigrations[last]!, 'up').mockRejectedValue(failure)
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-20T12:00:00Z'))

  await expect(migrateCore(db, config)).rejects.toHaveProperty('cause', failure)
  const files = await readdir(config.backupDirectory)
  expect(files).toHaveLength(1)
  expect(await executed()).toEqual(names.slice(0, -1))
  await db.destroy()
  db = createDatabase<CoreDatabase>(config.database)
  vi.setSystemTime(new Date('2026-10-20T12:01:01Z'))
  await expect(migrateCore(db, config)).rejects.toHaveProperty('cause', failure)
  expect(await readdir(config.backupDirectory)).toEqual(files)
  expect(migration).toHaveBeenCalledTimes(2)
  expect(info).toHaveBeenLastCalledWith(
    `[nextskin] 有 1 个迁移要执行，沿用本进程为这批迁移做的备份 ${join(config.backupDirectory, files[0]!)}；核心打不开期间手工改过库的话，请重启服务，会重新备份`,
  )
  migration.mockRestore()
  const onBackup = vi.fn()
  expect(await migrateCore(db, config, { onBackup })).toEqual([last])
  expect(onBackup).toHaveBeenCalledExactlyOnceWith(join(config.backupDirectory, files[0]!))
  expect(await readdir(config.backupDirectory)).toEqual(files)
})

test('备份失败后六十秒内重抛同一个错误，冷却结束后可以重试恢复', async () => {
  await migrateToLatest(db, previous)
  await writeFile(config.backupDirectory, '')
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['Date'] })
  const now = new Date('2026-10-20T12:00:00Z').getTime()
  vi.setSystemTime(now)
  const failure: unknown = await migrateCore(db, config).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(MigrationBackupError)

  // 修好目录后仍应保持冷却；若实际重试，就会产生目录和备份并执行迁移。
  await unlink(config.backupDirectory)
  await db.destroy()
  db = createDatabase<CoreDatabase>(config.database)
  vi.setSystemTime(now + 59_999)
  await expect(migrateCore(db, config)).rejects.toBe(failure)
  await expect(readdir(config.backupDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await executed()).toEqual(names.slice(0, -1))

  vi.setSystemTime(now + 60_000)
  expect(await migrateCore(db, config)).toEqual([last])
  expect(await readdir(config.backupDirectory)).toHaveLength(1)
  expect(await executed()).toEqual(names)
})

test('调用方持有的迁移报告在核心迁移失败后仍保留备份路径', async () => {
  await migrateToLatest(db, previous)
  vi.spyOn(coreMigrations[last]!, 'up').mockRejectedValue(new Error('migration failed'))
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const migrationReport: MigrationReport = { core: [], plugins: [], backup: null }
  await expect(openCore(config, { startJobs: false, migrationReport })).rejects.toThrow()
  expect(migrationReport.core).toEqual([])
  expect(migrationReport.plugins).toEqual([])
  expect(migrationReport.backup).toBe(join(config.backupDirectory, (await readdir(config.backupDirectory))[0]!))
  expect(await executed()).toEqual(names.slice(0, -1))
})
