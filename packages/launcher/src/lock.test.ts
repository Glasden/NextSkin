import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTestDirectory } from '@nextskin/db/testing'
import { expect, test } from 'vitest'
import { acquireDataLock } from './lock.ts'

test('子进程持锁时返回 null，强杀之后立即释放', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launcher-lock-'))
  const child = fork(fileURLToPath(new URL('./fixtures/hold-lock.ts', import.meta.url)), [directory], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  try {
    const [message] = (await once(child, 'message')) as [{ locked: boolean }]
    expect(message.locked).toBe(true)
    expect(await acquireDataLock(directory)).toBeNull()
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    const lock = await acquireDataLock(directory)
    expect(lock).not.toBeNull()
    lock?.release()
    lock?.release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    // 子进程刚被强杀时 Windows 可能还没放开它打开的文件，删目录偶发 ENOTEMPTY
    await removeTestDirectory(directory)
  }
})
