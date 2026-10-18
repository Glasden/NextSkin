import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))

async function run(...args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, ...args])
    return { code: 0, output: stdout + stderr }
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string }
    return { code: failed.code, output: failed.stdout + failed.stderr }
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

test('缺少旧库和材质目录时给出用法', async () => {
  const result = await run('--dry-run')
  expect(result.code).toBe(2)
  expect(result.output).toContain('缺少旧库')
  expect(result.output).toContain('用法：pnpm import:bs')
})
