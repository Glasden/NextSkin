import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTestDirectory } from '@nextskin/db/testing'
import { expect, test, vi } from 'vitest'
import { readConfig } from '../config.ts'
import { acquireDataLock } from '../lock.ts'
import { run } from './import.ts'

test('服务持锁时拒绝导入、--help 照常显示，命令正常或参数错误返回后释放锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-import-'))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  let held: Awaited<ReturnType<typeof acquireDataLock>> = null
  try {
    const context = await readConfig({ root, cwd: root, source: true, production: false, version: '0.0.0' }, {})
    const read = () => Promise.resolve(context)
    held = await acquireDataLock(context.config.dataDirectory)
    expect(await run(['--help'], read)).toBe(0)
    expect(await run(['--dry-run'], read)).toBe(2)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('导入前先停掉服务'))
    held?.release()
    expect(await run(['--dry-run'], read)).toBe(2)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('缺少旧库'))
    held = await acquireDataLock(context.config.dataDirectory)
    expect(held).not.toBeNull()
    held?.release()
  } finally {
    held?.release()
    error.mockRestore()
    log.mockRestore()
    await removeTestDirectory(root)
  }
})
