import { writeFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { backupSqlite, createDatabase, migrateToLatest, MigrationBackupError } from '../index.ts'
import { removeTestDirectory } from '../testing.ts'

type Schema = {
  items: { n: number }
}
let directory: string
let sourceFile: string
let db: Kysely<Schema>
const initial = {
  '0001_initial': {
    up: async (db: Kysely<unknown>) => {
      await db.schema.createTable('items').addColumn('n', 'integer').execute()
      await db.withTables<Schema>().insertInto('items').values({ n: 42 }).execute()
    },
  },
}
const now = new Date('2026-10-20T12:34:56.789Z')
const label = '0002_upgrade'

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nextskin-backup-'))
  sourceFile = join(directory, 'db.sqlite')
  db = createDatabase<Schema>({ dialect: 'sqlite', file: sourceFile })
  await migrateToLatest(db, initial)
})
afterEach(async () => {
  vi.restoreAllMocks()
  try {
    await db.destroy()
  } finally {
    await removeTestDirectory(directory)
  }
})

test('备份文件按 UTC 命名、返回绝对路径，能只读打开且数据一致', async () => {
  const file = await backupSqlite({ file: sourceFile, directory: join(directory, "backups'quoted"), label, now })
  expect(file).toBe(resolve(file))
  expect(basename(file)).toBe('nextskin-20261020T123456Z-0002_upgrade.sqlite')
  const backup = new DatabaseSync(file, { readOnly: true })
  try {
    expect(backup.prepare('select * from items').all()).toEqual([{ n: 42 }])
    expect(backup.prepare('select name from nextskin_migration').all()).toEqual([{ name: '0001_initial' }])
  } finally {
    backup.close()
  }
})

test('写连接仍打开时，备份包含 WAL 中尚未 checkpoint 的已提交数据', async () => {
  await sql`pragma wal_autocheckpoint = 0`.execute(db)
  await sql`pragma wal_checkpoint(truncate)`.execute(db)
  await db.insertInto('items').values({ n: 99 }).execute()
  expect((await stat(`${sourceFile}-wal`)).size).toBeGreaterThan(32)

  // 单独复制主文件来确认 99 仍只在 WAL 中，尚未写回主文件。
  const mainFile = join(directory, 'main-only.sqlite')
  await copyFile(sourceFile, mainFile)
  const main = new DatabaseSync(mainFile, { readOnly: true })
  try {
    expect(main.prepare('select n from items order by n').all()).toEqual([{ n: 42 }])
  } finally {
    main.close()
  }

  const backups = join(directory, 'backups')
  const file = await backupSqlite({ file: sourceFile, directory: backups, label, now })
  const backup = new DatabaseSync(file, { readOnly: true })
  try {
    expect(backup.prepare('select n from items order by n').all()).toEqual([{ n: 42 }, { n: 99 }])
    expect(await readdir(backups)).toEqual([basename(file)])
    expect(await db.selectFrom('items').selectAll().orderBy('n').execute()).toEqual([{ n: 42 }, { n: 99 }])
  } finally {
    backup.close()
  }
})

test('备份成功后按文件名只留最新三份，不认识的文件不动', async () => {
  const backups = join(directory, 'backups')
  await mkdir(backups)
  const old = [1, 2, 3, 4].map((day) => `nextskin-2026100${day}T000000Z-0001_initial.sqlite`)
  for (const name of [...old, 'manual.sqlite']) await writeFile(join(backups, name), 'keep')
  const file = await backupSqlite({ file: sourceFile, directory: backups, label, now })
  expect((await readdir(backups)).sort()).toEqual(['manual.sqlite', ...old.slice(2), basename(file)].sort())
})

test.each([1, 0, -1])('指定保留 %i 份时至少保留本次备份', async (keep) => {
  const backups = join(directory, 'backups')
  await mkdir(backups)
  await writeFile(join(backups, 'nextskin-20261001T000000Z-0001_initial.sqlite'), '')
  const file = await backupSqlite({ file: sourceFile, directory: backups, label, now, keep })
  expect(await readdir(backups)).toEqual([basename(file)])
})

test('备份目录是文件时抛出安全错误并保留原因，不执行新迁移', async () => {
  const backups = join(directory, 'backups')
  await writeFile(backups, '')
  const migrations = { ...initial, '0002_upgrade': { up: async () => {} } }
  const migration = migrateToLatest(db, migrations, {
    beforeUpgrade: async () => {
      await backupSqlite({ file: sourceFile, directory: backups, label, now })
    },
  })
  await expect(migration).rejects.toBeInstanceOf(MigrationBackupError)
  await expect(migration).rejects.toThrow(
    `迁移前备份数据库失败：没法写入 ${backups}；没有执行迁移。请检查数据目录的剩余空间和权限后重试`,
  )
  await expect(migration).rejects.toHaveProperty('cause', expect.any(Error))
  expect(await migrateToLatest(db, migrations)).toEqual(['0002_upgrade'])
})

test('同一秒同一批迁移连续备份两次都成功，正式文件只有一份且内容完整', async () => {
  const options = { file: sourceFile, directory: join(directory, 'backups'), label, now }
  const file = await backupSqlite(options)
  await db.updateTable('items').set({ n: 99 }).execute()
  expect(await backupSqlite(options)).toBe(file)
  expect(await readdir(options.directory)).toEqual([basename(file)])
  const backup = new DatabaseSync(file, { readOnly: true })
  try {
    expect(backup.prepare('select * from items').all()).toEqual([{ n: 99 }])
  } finally {
    backup.close()
  }
})

test('系统时间回拨时始终保留本次备份，另外保留最新两份', async () => {
  const backups = join(directory, 'backups')
  await mkdir(backups)
  const later = [1, 2, 3].map((day) => `nextskin-2026110${day}T000000Z-0001_initial.sqlite`)
  for (const name of later) await writeFile(join(backups, name), '')
  const file = await backupSqlite({ file: sourceFile, directory: backups, label, now })
  expect((await readdir(backups)).sort()).toEqual([basename(file), ...later.slice(1)].sort())
  expect((await stat(file)).isFile()).toBe(true)
})

test('清理超过一小时的遗留临时文件，一小时以内和不认识的文件不动', async () => {
  const backups = join(directory, 'backups')
  await mkdir(backups)
  const now = new Date('2026-10-20T12:00:00Z')
  const entries = [
    ['.nextskin-backup-old.partial', 61],
    ['.nextskin-backup-boundary.partial', 60],
    ['.nextskin-backup-recent.partial', 59],
    ['.manual.partial', 61],
  ] as const
  for (const [name, minutes] of entries) {
    const file = join(backups, name)
    await writeFile(file, '尚未完成')
    const modified = new Date(now.getTime() - minutes * 60 * 1000)
    await utimes(file, modified, modified)
  }
  const file = await backupSqlite({ file: sourceFile, directory: backups, label, now })
  expect((await readdir(backups)).sort()).toEqual(
    ['.nextskin-backup-boundary.partial', '.nextskin-backup-recent.partial', '.manual.partial', basename(file)].sort(),
  )
})

test.each([false, true])('VACUUM INTO 写了一半失败时只删除本次临时文件，已有正式备份：%s', async (existing) => {
  const backups = join(directory, 'backups')
  const options = { file: sourceFile, directory: backups, label, now }
  const file = join(backups, 'nextskin-20261020T123456Z-0002_upgrade.sqlite')
  if (existing) await backupSqlite(options)
  const original = existing ? await readFile(file) : null
  const failure = new Error('模拟磁盘已满')
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  vi.spyOn(StatementSync.prototype, 'run').mockImplementationOnce((target: unknown) => {
    if (typeof target !== 'string') throw new Error('VACUUM 的目标路径应为字符串')
    expect(basename(target)).toMatch(/^\.nextskin-backup-.+\.partial$/)
    writeFileSync(target, '尚未写完的数据库')
    throw failure
  })
  const backup = backupSqlite(options)
  await expect(backup).rejects.toBeInstanceOf(MigrationBackupError)
  await expect(backup).rejects.toHaveProperty('cause', failure)
  expect(close).toHaveBeenCalledOnce()
  expect(await readdir(backups)).toEqual(existing ? [basename(file)] : [])
  if (existing) expect(await readFile(file)).toEqual(original)
  expect(await db.selectFrom('items').selectAll().execute()).toEqual([{ n: 42 }])
})
