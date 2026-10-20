import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coreMigrations, createDatabase, migrateToLatest, type CoreDatabase } from '@nextskin/db'
import { removeTestDirectory } from '@nextskin/db/testing'
import { coreConfigFromEnv } from '@nextskin/domain/config'
import { expect, test, vi } from 'vitest'
import type { CommandContext } from '../context.ts'
import { run } from './migrate.ts'

test('升级前备份失败时打印可操作的安全文案并返回 1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-migrate-'))
  const config = coreConfigFromEnv({ NEXTSKIN_DATA_DIR: root }, { cwd: root, production: false })
  const db = createDatabase<CoreDatabase>(config.database)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const names = Object.keys(coreMigrations).sort()
    const last = names.at(-1)!
    await migrateToLatest(db, Object.fromEntries(Object.entries(coreMigrations).filter(([name]) => name !== last)))
    await writeFile(config.backupDirectory, '')
    const context: CommandContext = {
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
    expect(await run([], () => Promise.resolve(context))).toBe(1)
    expect(error).toHaveBeenCalledExactlyOnceWith(
      `[nextskin] 迁移前备份数据库失败：没法写入 ${config.backupDirectory}；没有执行迁移。请检查数据目录的剩余空间和权限后重试`,
    )
    expect(log).not.toHaveBeenCalled()
    expect(await migrateToLatest(db, coreMigrations)).toEqual([last])
  } finally {
    error.mockRestore()
    log.mockRestore()
    try {
      await db.destroy()
    } finally {
      await removeTestDirectory(root)
    }
  }
})
