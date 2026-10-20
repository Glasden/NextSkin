import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import metadata from '../package.json' with { type: 'json' }

async function run(...args: string[]) {
  return runWith({}, ...args)
}

async function runWith(env: NodeJS.ProcessEnv, ...args: string[]) {
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./main.ts', import.meta.url)), ...args],
      { env: { ...process.env, ...env } },
    )
    return { code: 0, output: result.stdout + result.stderr }
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string }
    return { code: result.code, output: result.stdout + result.stderr }
  }
}

test('未知命令退出 1；缺失或错误的导入子命令给出用法', async () => {
  for (const argv of [['unknown'], ['import'], ['import', 'unknown']]) {
    const result = await run(...argv)
    expect(result.code).toBe(1)
    expect(result.output).toContain('用法：')
  }
})

test('version 和 help 不需要配置或数据库，兼容 pnpm 的 --', async () => {
  expect(await run('--', 'version')).toEqual({ code: 0, output: metadata.version + '\n' })
  for (const argv of [[], ['help'], ['--help'], ['-h']]) {
    const result = await run(...argv)
    expect(result.code).toBe(0)
    expect(result.output).toContain('pnpm nextskin <命令>')
  }
})

test('命令先检查参数、处理 --help，再读配置', async () => {
  // 配置文件指向一个目录，读配置一定失败
  const env = { NEXTSKIN_ENV_FILE: fileURLToPath(new URL('.', import.meta.url)) }
  const help = await runWith(env, 'import', 'blessing-skin', '--help')
  expect(help.code).toBe(0)
  expect(help.output).toContain('用法：nextskin import blessing-skin')
  expect((await runWith(env, 'import', 'blessing-skin', '--frm')).code).toBe(2)
  for (const argv of [['set-role'], ['set-password'], ['disable-2fa'], ['disable-captcha', 'extra']]) {
    const result = await runWith(env, ...argv)
    expect(result.code).toBe(1)
    expect(result.output).toContain('用法：')
  }
  const configured = await runWith(env, 'migrate')
  expect(configured.code).toBe(78)
  expect(configured.output).toContain('读不了配置文件')
})

test('源码模式 start 是配置错误，退出 78', async () => {
  const result = await run('start')
  expect(result.code).toBe(78)
  expect(result.output).toContain('[nextskin] start 只能在发行目录里运行')
})

test('发行入口在旧 Node 上先报版本错误，退出 78', async () => {
  const errors: string[] = []
  const process = { versions: { node: '18.20.0' }, exitCode: 0 }
  runInNewContext(await readFile(new URL('../release/nextskin.mjs', import.meta.url), 'utf8'), {
    process,
    console: { error: (message: string) => errors.push(message) },
  })
  expect(process.exitCode).toBe(78)
  expect(errors.join()).toContain('需要 Node 24 或更新版本，推荐 Node 26；当前版本 18.20.0')
})

test('doctor 先处理帮助和参数，不读取配置', async () => {
  const env = { NEXTSKIN_ENV_FILE: fileURLToPath(new URL('.', import.meta.url)) }
  for (const flag of ['--help', '-h']) {
    const result = await runWith(env, 'doctor', flag)
    expect(result.code).toBe(0)
    expect(result.output).toContain('用法：nextskin doctor')
  }
  const result = await runWith(env, 'doctor', 'extra')
  expect(result.code).toBe(1)
  expect(result.output).toContain('用法：nextskin doctor')
})
