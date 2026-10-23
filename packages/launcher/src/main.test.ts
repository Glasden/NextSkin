import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { removeTestDirectory } from '@nextskin/db/testing'
import { expect, test, vi } from 'vitest'
import metadata from '../package.json' with { type: 'json' }
import { run as disable2fa } from './commands/disable-2fa.ts'
import { run as disableCaptcha } from './commands/disable-captcha.ts'
import { run as maintenance } from './commands/maintenance.ts'
import { checkConfig, run as doctor } from './commands/doctor.ts'
import { run as importBlessingSkin } from './commands/import.ts'
import { run as setPassword } from './commands/set-password.ts'
import { run as setRole } from './commands/set-role.ts'
import type { LauncherContext, ReadCommandContext } from './context.ts'

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

/** 在进程内调用命令，收集它打印的内容。各命令模块都会加载领域层，逐个起进程在负载高的 CI 上超过 30 秒 */
async function capture(call: () => Promise<number>) {
  const lines: unknown[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((line) => lines.push(line))
  const error = vi.spyOn(console, 'error').mockImplementation((line) => lines.push(line))
  try {
    return { code: await call(), output: lines.join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
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
    expect(result.output).toContain('maintenance [on|off]')
  }
})

test('命令先检查参数、处理 --help，再读配置', async () => {
  const read = vi.fn<ReadCommandContext>(() => Promise.reject(new Error('参数有错时不应读取配置')))
  const help = await capture(() => importBlessingSkin(['--help'], read))
  expect(help.code).toBe(0)
  expect(help.output).toContain('用法：nextskin import blessing-skin')
  expect((await capture(() => importBlessingSkin(['--frm'], read))).code).toBe(2)
  for (const call of [
    () => setRole([], read),
    () => setPassword([], read),
    () => disable2fa([], read),
    () => disableCaptcha(['extra'], read),
    () => maintenance(['extra'], read),
    () => maintenance(['on', 'off'], read),
  ]) {
    const result = await capture(call)
    expect(result.code).toBe(1)
    expect(result.output).toContain('用法：')
  }
  expect(read).not.toHaveBeenCalled()
})

test('读不了配置是配置错误，退出 78', async () => {
  // 配置文件指向一个目录，读配置一定失败
  const env = { NEXTSKIN_ENV_FILE: fileURLToPath(new URL('.', import.meta.url)) }
  const result = await runWith(env, 'migrate')
  expect(result.code).toBe(78)
  expect(result.output).toContain('读不了配置文件')
})

test.each([false, true])(
  'NEXTSKIN_HOME 从进程环境读取，相对路径按进程工作目录解析（相对：%s）',
  async (relativeHome) => {
    const home = await mkdtemp(join(tmpdir(), 'launcher-home-'))
    try {
      const file = join(home, 'config-directory')
      await mkdir(file)
      const result = await runWith(
        {
          NEXTSKIN_HOME: relativeHome ? relative(process.cwd(), home) : home,
          NEXTSKIN_ENV_FILE: 'config-directory',
          INIT_CWD: join(home, 'elsewhere'),
        },
        'migrate',
      )
      expect(result.code).toBe(78)
      expect(result.output).toContain(`读不了配置文件 ${file}`)
    } finally {
      await removeTestDirectory(home)
    }
  },
)

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
  const context: LauncherContext = { root: '/', cwd: '/', source: true, production: false, version: '0.0.0' }
  // 给一个读不了的配置文件：真去读配置，输出就不止用法这一行
  const options = { env: { NEXTSKIN_ENV_FILE: fileURLToPath(new URL('.', import.meta.url)) } }
  for (const flag of ['--help', '-h']) {
    const result = await capture(() => doctor([flag], context, options))
    expect(result).toEqual({ code: 0, output: '用法：nextskin doctor [--json]' })
  }
  expect(await capture(() => doctor(['extra'], context, options))).toEqual({
    code: 1,
    output: '用法：nextskin doctor [--json]',
  })
})

test.each(['unset', 'same', 'different'] as const)(
  'doctor 按实例目录解析配置，仅目录不同时输出实例目录：%s',
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), 'launcher-doctor-'))
    try {
      const context: LauncherContext = {
        root: root + '/',
        cwd: root,
        source: false,
        production: true,
        version: '0.0.0',
        ...(state !== 'unset' ? { home: state === 'same' ? root : join(root, 'instance') } : {}),
      }
      const home = context.home ?? root
      const parsed = checkConfig(context, {
        NEXTSKIN_DATA_DIR: 'storage',
        NEXTSKIN_DATABASE_URL: 'sqlite:db/site.sqlite',
      })
      expect(parsed.config?.dataDirectory).toBe(join(home, 'storage'))
      expect(parsed.config?.database).toEqual({ dialect: 'sqlite', file: join(home, 'db/site.sqlite') })
      const result = await capture(() => doctor([], context, { env: { NEXTSKIN_ENV_FILE: root } }))
      expect(result.output.split('\n')[0]).toBe(
        `NextSkin 0.0.0 环境自检，根目录 ${context.root}${state === 'different' ? `，实例目录 ${home}` : ''}`,
      )
    } finally {
      await removeTestDirectory(root)
    }
  },
)

test('maintenance 命令已登记，错误参数给出专用用法', async () => {
  expect(await run('maintenance', 'invalid')).toEqual({ code: 1, output: '用法：nextskin maintenance [on|off]\n' })
})
