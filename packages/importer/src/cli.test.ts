import { expect, test, vi } from 'vitest'
import type { CoreConfig } from '@nextskin/domain/config'
import { checkImportArgs, runImportCli } from './cli.ts'

async function run(...args: string[]): Promise<{ code: number; output: string }> {
  return capture(() => runImportCli(args, { config: {} as CoreConfig, cwd: '/unused' }))
}

async function capture<T>(action: () => T | Promise<T>): Promise<{ code: T; output: string }> {
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((message: string) => {
    lines.push(message)
  })
  const error = vi.spyOn(console, 'error').mockImplementation((message: string) => {
    lines.push(message)
  })
  try {
    const code = await action()
    return { code, output: lines.join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

test('参数错误时不回显参数的值：连接地址里可能有密码（不变量 11）', async () => {
  const positional = await run('--dry-run', 'mysql://bs:hunter2-secret@db/blessingskin')
  expect(positional.code).toBe(2)
  expect(positional.output).toContain('有多余的值')
  expect(positional.output).not.toContain('hunter2')
  const unknown = await run('--frm=mysql://bs:hunter2-secret@db/blessingskin')
  expect(unknown.code).toBe(2)
  expect(unknown.output).toContain('不认识的参数：--frm')
  expect(unknown.output).not.toContain('hunter2')
  const missing = await run('--from')
  expect(missing.code).toBe(2)
})

test('读配置之前的检查：--help 退出 0，写错的参数和 runImportCli 一样退出 2，其余留给 runImportCli', async () => {
  const help = await capture(() => checkImportArgs(['--', '-h']))
  expect(help.code).toBe(0)
  expect(help.output).toContain('用法：nextskin import blessing-skin')
  const unknown = await capture(() => checkImportArgs(['--frm=mysql://bs:hunter2-secret@db/blessingskin']))
  expect(unknown.code).toBe(2)
  expect(unknown.output).toContain('不认识的参数：--frm')
  expect(unknown.output).not.toContain('hunter2')
  expect(checkImportArgs(['--dry-run'])).toBeNull()
})

test('缺少旧库和材质目录时给出用法', async () => {
  const result = await run('--dry-run')
  expect(result.code).toBe(2)
  expect(result.output).toContain('缺少旧库')
  expect(result.output).toContain('用法：nextskin import blessing-skin')
})
