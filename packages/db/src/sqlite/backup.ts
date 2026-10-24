import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getLogger } from '@nextskin/logging'

export class MigrationBackupError extends Error {}

/** SQLite 核心迁移之前的完整数据库备份（ADR-0040），不包含材质文件。 */
export async function backupSqlite(options: {
  file: string
  directory: string
  label: string
  keep?: number
  now?: Date
}): Promise<string> {
  const directory = resolve(options.directory)
  const now = options.now ?? new Date()
  const timestamp = now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  const filename = `nextskin-${timestamp}-${options.label}.sqlite`
  const file = join(directory, filename)
  const temporary = join(directory, `.nextskin-backup-${randomUUID()}.partial`)
  try {
    await mkdir(directory, { recursive: true })
    const source = new DatabaseSync(options.file, { readOnly: true })
    try {
      source.exec('pragma busy_timeout = 5000')
      source.prepare('vacuum into ?').run(temporary)
    } finally {
      source.close()
    }
    await rename(temporary, file)
  } catch (cause) {
    // 每次只清理自己的临时文件，不能删除其他进程已经完成的正式备份。
    await rm(temporary, { force: true }).catch(() => {})
    throw new MigrationBackupError(
      `迁移前备份数据库失败：没法写入 ${directory}；没有执行迁移。请检查数据目录的剩余空间和权限后重试`,
      { cause },
    )
  }

  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !/^\.nextskin-backup-.+\.partial$/.test(entry.name)) continue
      try {
        const temporary = join(directory, entry.name)
        if (now.getTime() - (await stat(temporary)).mtimeMs > 60 * 60 * 1000) await rm(temporary, { force: true })
      } catch {
        // 遗留临时文件清理失败不影响本次已完成的备份。
      }
    }
    const backups = entries
      .filter(
        (entry) => entry.isFile() && entry.name !== filename && /^nextskin-\d{8}T\d{6}Z-.+\.sqlite$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse()
    // 无论系统时间是否回拨，本次的备份都必须保留。
    for (const name of backups.slice(Math.max(1, options.keep ?? 3) - 1)) await unlink(join(directory, name))
  } catch {
    getLogger('backup').warn(`清理旧的数据库备份失败：${directory}；备份已成功，继续执行迁移。`)
  }
  return file
}
