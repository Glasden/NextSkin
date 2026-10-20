import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createDatabase, type CoreDatabase } from '@nextskin/db'
import { migrateCore, MigrationBackupError } from '@nextskin/domain'
import type { ReadCommandContext } from '../context.ts'

export async function run(_argv: string[], read: ReadCommandContext): Promise<number> {
  const context = await read()
  let db: ReturnType<typeof createDatabase<CoreDatabase>> | undefined
  try {
    if (context.config.database.dialect === 'sqlite')
      await mkdir(dirname(context.config.database.file), { recursive: true })
    db = createDatabase<CoreDatabase>(context.config.database)
    const names = await migrateCore(db, context.config)
    for (const name of names) console.log(`[nextskin] 已执行迁移 ${name}`)
    if (!names.length) console.log('[nextskin] 没有要执行的迁移')
    return 0
  } catch (error) {
    console.error(
      error instanceof MigrationBackupError
        ? `[nextskin] ${error.message}`
        : '[nextskin] 执行迁移失败；请检查数据库配置、连接和权限。',
    )
    return 1
  } finally {
    await db?.destroy()
  }
}
