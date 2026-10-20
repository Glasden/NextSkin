import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 事务锁依附连接；在进程生命周期里持有强引用，不能让 GC 提前关掉它。
const held = new Set<DatabaseSync>()

export async function acquireDataLock(directory: string): Promise<{ release(): void } | null> {
  await mkdir(directory, { recursive: true })
  const db = new DatabaseSync(join(directory, 'nextskin.lock'), { timeout: 0 })
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db.close()
    if ((error as { errcode?: number }).errcode === 5) return null
    throw error
  }
  held.add(db)
  return {
    release() {
      if (held.delete(db)) db.close()
    },
  }
}
