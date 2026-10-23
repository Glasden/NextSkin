import { chown, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ManagerError } from './types.ts'
import type { RunAs } from './run-as.ts'
import { sleep } from './state.ts'

export interface Lock {
  release(): void
}
const held = new Set<DatabaseSync>()

// 和 packages/launcher/src/lock.ts 做法相同：排他事务依附连接，进程退出自动释放，不用清理 PID 文件。
interface LockOptions {
  runAs?: RunAs
  chown?: typeof chown
}
export async function acquireLock(file: string, options: LockOptions = {}): Promise<Lock | null> {
  await mkdir(dirname(file), { recursive: true })
  if (options.runAs) {
    let created = false
    try {
      // 独占创建才能判断归属，不能靠先 stat 再打开而误改其他进程创建的锁。
      await writeFile(file, '', { flag: 'wx', mode: 0o600 })
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (created) {
      try {
        await (options.chown ?? chown)(file, options.runAs.uid, options.runAs.gid)
      } catch (error) {
        await rm(file, { force: true })
        throw error
      }
    }
  }
  const db = new DatabaseSync(file, { timeout: 0 })
  try {
    // 空库的 BEGIN 会初始化页并创建 journal；锁不提交数据，内存 journal 避免留下 root 的旁路文件。
    if (options.runAs) db.exec('PRAGMA journal_mode=MEMORY')
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

export async function waitForLock(
  file: string,
  options: LockOptions & {
    signal?: AbortSignal
    timeout?: number
    interval?: number
    now?: () => number
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    acquire?: typeof acquireLock
    log?: (line: string) => void
  } = {},
): Promise<Lock | null> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeout ?? 40_000)
  let waiting = false
  for (;;) {
    if (options.signal?.aborted) return null
    let lock: Lock | null
    try {
      lock = await (options.acquire ?? acquireLock)(file, options)
    } catch {
      throw new ManagerError('无法取得进程锁，请检查目录权限')
    }
    if (options.signal?.aborted) {
      lock?.release()
      return null
    }
    if (lock) return lock
    if (now() >= deadline) throw new ManagerError('另一个进程仍在运行，等待进程锁超时')
    if (!waiting) (options.log ?? console.error)('[nextskin] 另一个进程还在运行，等待它退出，最多 40 秒')
    waiting = true
    await (options.sleep ?? interruptibleSleep)(Math.min(options.interval ?? 500, deadline - now()), options.signal)
  }
}

export async function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}
