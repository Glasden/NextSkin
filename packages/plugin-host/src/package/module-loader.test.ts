import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const exec = promisify(execFile)
test.each([[], ['--permission', '--allow-fs-read=*', '--allow-fs-write=*']])(
  '独立进程共享模块实例并拒绝其他裸说明符（%j）',
  async (...flags) => {
    const script = fileURLToPath(new URL('./fixtures/module-hooks.ts', import.meta.url))
    const result = await exec(process.execPath, [...flags, script], { timeout: 10_000 })
    expect(result.stdout).toBe('')
  },
  // 比子进程的 10 秒长，超时时报的是子进程的错误
  20_000,
)
