import { createMemoryLogger } from '@nextskin/logging'
import type { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, readFile, rm, writeFile, type chown } from 'node:fs/promises'
import { join } from 'node:path'
import { MANIFEST_URL } from '@nextskin/updates'
import { runManagementCommand } from './cli.ts'
import { createControl } from './control.ts'
import { fixture, events, releaseZip, requestUrl, signedManifest, zipResponse } from './fixtures.ts'
import { acquireLock } from './lock.ts'
import { initialCurrent, readCurrent, writeCurrent } from './state.ts'
import type { InternalManagerStatus, Manager, Preflight, UpdateLog } from './types.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})
async function setup() {
  const f = await fixture()
  disposers.push(f.dispose)
  const zip = releaseZip('1.1.0')
  const signed = signedManifest(zip)
  const fetcher = vi.fn<typeof fetch>((input) =>
    Promise.resolve(requestUrl(input) === MANIFEST_URL ? Response.json(signed.body) : zipResponse(zip)),
  )
  const output = vi.fn<(line: string) => void>()
  const error = vi.fn<(line: string) => void>()
  const options = { output, error, manager: { keys: signed.keys, fetch: fetcher }, isTTY: false, pollInterval: 1 }
  const run = (args: string[], bundled = '1.0.0') => runManagementCommand(f.home, bundled, args, options)
  return { ...f, output, error, fetcher, options, run }
}

describe('停服时的命令', () => {
  it('离线流水线的日志只写 stderr，不进入命令 output 或 stdout', async () => {
    const f = await setup()
    const lock = (await acquireLock(join(f.home, 'data/nextskin.lock')))!
    disposers.push(() => Promise.resolve(lock.release()))
    vi.stubEnv('NEXTSKIN_LOG_LEVEL', 'info')
    vi.stubEnv('NEXTSKIN_LOG_FORMAT', 'json')
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(
        await runManagementCommand(f.home, '1.1.0', ['update', '--to', '1.1.0', '--yes'], {
          ...f.options,
          manager: { ...f.options.manager, sleep: () => Promise.resolve(lock.release()) },
        }),
      ).toBe(0)
      expect(stdout).not.toHaveBeenCalled()
      expect(stderr).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(stderr.mock.calls[0]![0]))).toMatchObject({
        source: 'manager',
        level: 'info',
        msg: '另一个进程还在运行，等待它退出，最多 5 秒',
      })
      expect(f.error).not.toHaveBeenCalled()
      expect(f.output.mock.calls).toEqual([
        ['预检：sqlite；核心迁移 0 条；插件迁移 0 条；档位 none'],
        ['不兼容的插件：无'],
        ['预计停站几秒到三十多秒；实际时间取决于数据库迁移，健康检查最多等待两分钟'],
        ['manual 1.0.0 → 1.1.0：success'],
      ])
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
      vi.unstubAllEnvs()
    }
  })
  it('--check 读签名清单，不拿锁、不启动', async () => {
    const f = await setup()
    const lock = (await acquireLock(join(f.home, 'releases/manager.lock')))!
    try {
      expect(await f.run(['update', '--check', '--json'])).toBe(0)
      expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject([{ version: '1.1.0' }])
      expect(await events(f.home)).toEqual([])
    } finally {
      lock.release()
    }
  })
  it('默认选最新正式版，--yes 完成迁移和切换而不启动；rollback --yes 恢复 SQLite', async () => {
    const f = await setup()
    f.behavior['1.1.0'] = { pending: true }
    await f.configure()
    expect(await f.run(['update', '--yes'])).toBe(0)
    expect(await readCurrent(f.home)).toMatchObject({ current: '1.1.0', previous: '1.0.0' })
    expect(await readFile(join(f.home, 'data/db.sqlite'), 'utf8')).toBe('db:1.1.0')
    expect((await events(f.home)).some((e) => e.command === 'start')).toBe(false)
    expect((await events(f.home)).some((e) => e.command === 'migrate')).toBe(true)
    expect(await f.run(['rollback', '--yes'])).toBe(0)
    expect(await readCurrent(f.home)).toMatchObject({ current: '1.0.0', previous: null })
    expect(await readFile(join(f.home, 'data/db.sqlite'), 'utf8')).toBe('original')
    expect(f.output.mock.calls.flat().join('\n')).toContain('升级以后的所有写入都会丢失')
    expect((await events(f.home)).some((e) => e.command === 'start')).toBe(false)
  })
  it('手动解压本地版本不下载，外部备份未确认退出 1，确认后可完成', async () => {
    const f = await setup()
    f.behavior['1.1.0'] = { dialect: 'postgres', pending: true }
    await f.configure()
    expect(await f.run(['update', '--to', '1.1.0', '--yes'], '1.1.0')).toBe(1)
    expect(f.error).toHaveBeenCalledWith(expect.stringContaining('--backup-confirmed'))
    expect((await readCurrent(f.home))?.current).toBe('1.0.0')
    expect((await events(f.home)).some((e) => e.command === 'migrate')).toBe(false)
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(await f.run(['update', '--to', '1.1.0', '--yes', '--backup-confirmed'], '1.1.0')).toBe(0)
    expect(await f.run(['rollback', '--yes'])).toBe(0)
    expect(f.output.mock.calls.flat().join('\n')).toContain('服务停着、数据库已经用升级前的备份恢复了，才能继续')
    expect(f.output).toHaveBeenCalledWith('已切换到 1.0.0，启动服务即可')
  })
  it('非 TTY 必须 --yes；TTY 只问一次并支持拒绝', async () => {
    const f = await setup()
    expect(await f.run(['update', '--to', '1.1.0'], '1.1.0')).toBe(1)
    expect(f.error).toHaveBeenCalledWith(expect.stringContaining('非 TTY'))
    const confirm = vi.fn(() => Promise.resolve(false))
    expect(
      await runManagementCommand(f.home, '1.1.0', ['update', '--to', '1.1.0'], { ...f.options, isTTY: true, confirm }),
    ).toBe(1)
    expect(confirm).toHaveBeenCalledTimes(1)
    confirm.mockResolvedValue(true)
    expect(
      await runManagementCommand(f.home, '1.1.0', ['update', '--to', '1.1.0'], { ...f.options, isTTY: true, confirm }),
    ).toBe(0)
    expect(confirm).toHaveBeenCalledTimes(2)
  })
  it('releases 标出 current、previous、bundled、failed，离线 status 读持久记录', async () => {
    const f = await setup()
    expect(await f.run(['update', '--to', '1.1.0', '--yes'], '1.1.0')).toBe(0)
    const pointer = (await readCurrent(f.home))!
    await writeCurrent(f.home, { ...pointer, failed: ['1.1.0'] })
    f.output.mockClear()
    expect(await f.run(['releases', '--json'], '1.1.0')).toBe(0)
    expect(JSON.parse(f.output.mock.calls[0]![0])).toEqual({
      running: false,
      releases: [
        { version: '1.1.0', current: true, previous: false, bundled: true, failed: true },
        { version: '1.0.0', current: false, previous: true, bundled: false, failed: false },
      ],
    })
    f.output.mockClear()
    expect(await f.run(['update', 'status', '--json'])).toBe(0)
    expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({
      current: '1.1.0',
      previous: '1.0.0',
      lastResult: { result: 'success', step: 'cleanup' },
    })
    expect(await f.run(['update', 'status'])).toBe(0)
    expect(f.output.mock.calls.flat().join('\n')).toContain('未运行')
  })
  it('无法拿锁退出 1；损坏配置退出 78；严格拒绝多余参数', async () => {
    const f = await setup()
    const lock = (await acquireLock(join(f.home, 'releases/manager.lock')))!
    try {
      expect(await f.run(['update', '--to', '1.1.0', '--yes'])).toBe(1)
      expect(f.error).toHaveBeenCalledWith(expect.stringContaining('控制通道连不上'))
    } finally {
      lock.release()
    }
    for (const args of [
      ['update', '--unknown'],
      ['rollback', '--json'],
      ['releases', '--yes'],
      ['update', 'status', '--to', '1.1.0'],
      ['update', '--check', '--yes'],
      ['update', '--json'],
      ['update', '--to', '../bad'],
      ['update', '--to'],
      ['update', 'extra'],
    ])
      expect(await f.run(args)).toBe(1)
    await writeFile(join(f.home, 'releases/current.json'), '{bad}')
    expect(await f.run(['update', 'status'])).toBe(78)
  })
})

it('运行中的命令使用真实控制服务与假 Manager：prepare、进度、apply、status、releases、rollback', async () => {
  const f = await setup()
  const state: InternalManagerStatus = {
    current: '1.0.0',
    previous: null,
    operation: null,
    prepared: null,
    lastResult: null,
  }
  const prepared: Preflight = {
    version: '1.1.0',
    dataDirectory: f.home,
    sqliteFile: null,
    dialect: 'mysql',
    pendingCore: [],
    pendingPlugins: [],
    incompatiblePlugins: [],
    tier: 'none',
  }
  const result = (kind: 'update' | 'rollback', from: string, to: string): UpdateLog => ({
    at: new Date().toISOString(),
    kind,
    from,
    to,
    result: 'success',
    step: 11,
  })
  const manager: Manager = {
    status: () => structuredClone(state),
    check: vi.fn(),
    prepareLocal: vi.fn(),
    cancel: vi.fn(),
    prepare: vi.fn(async () => {
      state.operation = {
        kind: 'prepare',
        version: '1.1.0',
        step: 3,
        startedAt: new Date().toISOString(),
        progress: { received: 50, total: 100 },
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
      state.prepared = prepared
      state.operation = null
      return prepared
    }),
    apply: vi.fn(async () => {
      state.operation = { kind: 'apply', version: '1.1.0', step: 7, startedAt: new Date().toISOString() }
      await new Promise((resolve) => setTimeout(resolve, 20))
      await writeCurrent(f.home, {
        ...initialCurrent('1.1.0'),
        previous: '1.0.0',
        upgrades: { '1.1.0': { from: '1.0.0', migrations: false, dialect: 'mysql', backup: null } },
      })
      state.current = '1.1.0'
      state.prepared = null
      state.lastResult = result('update', '1.0.0', '1.1.0')
      state.operation = null
      return state.lastResult
    }),
    rollback: vi.fn(async () => {
      await writeCurrent(f.home, initialCurrent('1.0.0'))
      state.current = '1.0.0'
      state.lastResult = result('rollback', '1.1.0', '1.0.0')
      return state.lastResult
    }),
  }
  const service = await createControl({ home: f.home, bundled: '1.0.0', manager })
  disposers.push(service.close)
  expect(await f.run(['update', '--to', '1.1.0', '--yes'])).toBe(0)
  expect(manager.prepare).toHaveBeenCalledWith('1.1.0')
  expect(manager.apply).toHaveBeenCalledWith('1.1.0', { backupConfirmed: false })
  expect(f.output.mock.calls.flat().join('\n')).toContain('50/100 字节')
  expect(await f.run(['update', 'status', '--json'])).toBe(0)
  expect(JSON.parse(f.output.mock.calls.at(-1)![0])).toMatchObject({ protocol: 1, current: '1.1.0' })
  expect(await f.run(['releases', '--json'])).toBe(0)
  expect(JSON.parse(f.output.mock.calls.at(-1)![0])).toMatchObject({ running: true })
  expect(await f.run(['rollback', '--yes'])).toBe(0)
  expect(manager.rollback).toHaveBeenCalledWith({ confirmed: true })
  expect(f.fetcher).not.toHaveBeenCalled()
})

it('离线迁移失败即使自动换回旧指针，也退出 1 且不启动服务', async () => {
  const f = await setup()
  f.behavior['1.1.0'] = { pending: true, migrateFail: true }
  await f.configure()
  expect(await f.run(['update', '--to', '1.1.0', '--yes'], '1.1.0')).toBe(1)
  expect((await readCurrent(f.home))?.current).toBe('1.0.0')
  expect((await events(f.home)).some((e) => e.command === 'start')).toBe(false)
  expect(f.output.mock.calls.flat().join('\n')).toContain('rolled-back')
})

it.skipIf(process.platform === 'win32')(
  '离线 update/rollback 从环境解析 RUN_AS，所有 doctor/migrate 均使用服务身份',
  async () => {
    const f = await setup()
    const { spawn } = await import('node:child_process')
    const identity = vi
      .fn<typeof execFileSync>()
      .mockReturnValueOnce('1234\n')
      .mockReturnValueOnce('5678\n')
      .mockReturnValueOnce('1234\n')
      .mockReturnValueOnce('5678\n')
    const ownership = vi.fn<typeof chown>().mockResolvedValue(undefined)
    const calls: { command: string; uid: number | undefined; gid: number | undefined }[] = []
    const spawnChild = ((...args: Parameters<typeof spawn>) => {
      calls.push({ command: String(args[1][1]), uid: args[2].uid, gid: args[2].gid })
      const actual = { ...args[2] }
      delete actual.uid
      delete actual.gid
      return spawn(args[0], args[1], actual)
    }) as typeof spawn
    const { logger, records } = createMemoryLogger({ source: 'manager' })
    const options = {
      ...f.options,
      manager: {
        ...f.options.manager,
        log: logger,
        env: { ...process.env, NEXTSKIN_RUN_AS: 'nextskin' },
        getuid: () => 0,
        execFileSync: identity,
        chown: ownership,
        spawn: spawnChild,
      },
    }
    expect(await runManagementCommand(f.home, '1.1.0', ['update', '--to', '1.1.0', '--yes'], options)).toBe(0)
    expect(await runManagementCommand(f.home, '1.1.0', ['rollback', '--yes'], options)).toBe(0)
    expect(identity).toHaveBeenCalledTimes(4)
    expect(calls.map((call) => call.command)).toEqual(['doctor', 'doctor', 'migrate', 'doctor'])
    for (const call of calls) expect(call).toMatchObject({ uid: 1234, gid: 5678 })
    expect(records).toHaveLength(2)
    expect(records).toMatchObject([
      { level: 'info', msg: '以 nextskin（1234/5678）运行服务' },
      { level: 'info', msg: '以 nextskin（1234/5678）运行服务' },
    ])
    expect(f.error).not.toHaveBeenCalled()
  },
)

it('离线 update 和 rollback 的数据归属错误退出 78', async () => {
  const f = await setup()
  const { stat } = await import('node:fs/promises')
  const info = await stat(join(f.home, 'data'))
  info.uid = 1234
  const options = {
    ...f.options,
    manager: { ...f.options.manager, env: {}, getuid: () => 0, stat: vi.fn(() => Promise.resolve(info)) },
  }
  expect(await runManagementCommand(f.home, '1.1.0', ['update', '--to', '1.1.0', '--yes'], options)).toBe(78)
  await writeCurrent(f.home, {
    ...initialCurrent('1.1.0'),
    previous: '1.0.0',
    upgrades: { '1.1.0': { from: '1.0.0', migrations: false, dialect: 'sqlite', backup: null } },
  })
  expect(await runManagementCommand(f.home, '1.1.0', ['rollback', '--yes'], options)).toBe(78)
  expect(f.error.mock.calls.flat().join('\n')).toContain('或者设 NEXTSKIN_RUN_AS=<用户>')
  expect((await events(f.home)).some((event) => ['migrate', 'start'].includes(event.command))).toBe(false)
})

it('旧布局外部库先拒绝未确认备份，再用已解压版本离线升级并删除旧目录', async () => {
  const f = await setup()
  await rm(join(f.home, 'releases/current.json'))
  await mkdir(join(f.home, 'server'))
  await mkdir(join(f.home, 'cli'))
  await writeFile(join(f.home, 'server/VERSION'), '0.9.0')
  f.behavior['1.1.0'] = { dialect: 'postgres', pending: true }
  await f.configure()
  expect(await f.run(['update', '--yes'], '1.1.0')).toBe(1)
  expect(f.error).toHaveBeenCalledWith(expect.stringContaining('--backup-confirmed'))
  expect(await readCurrent(f.home)).toBeNull()
  await access(join(f.home, 'server/VERSION'))
  await access(join(f.home, 'cli'))
  expect((await events(f.home)).some((e) => e.command === 'migrate')).toBe(false)
  expect(await f.run(['update', '--backup-confirmed', '--yes'], '1.1.0')).toBe(0)
  expect(await readCurrent(f.home)).toMatchObject({ current: '1.1.0', previous: null })
  await expect(access(join(f.home, 'server'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(join(f.home, 'cli'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse((await readFile(join(f.home, 'releases/update-log.jsonl'), 'utf8')).trim())).toMatchObject({
    kind: 'legacy',
    from: '0.9.0',
    result: 'success',
  })
  expect(f.fetcher).not.toHaveBeenCalled()
  expect((await events(f.home)).some((e) => e.command === 'start')).toBe(false)
})

it('旧布局不能直接指定其他版本，必须先用自带版本', async () => {
  const f = await setup()
  await rm(join(f.home, 'releases/current.json'))
  await mkdir(join(f.home, 'server'))
  await mkdir(join(f.home, 'cli'))
  await writeFile(join(f.home, 'server/VERSION'), '0.9.0')
  expect(await f.run(['update', '--to', '1.2.0', '--yes'], '1.1.0')).toBe(1)
  expect(f.error).toHaveBeenCalledWith(expect.stringContaining('先换到已解压'))
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(await events(f.home)).toEqual([])
})

it('有指针的手动解压默认选 bundled，不读清单', async () => {
  const f = await setup()
  f.behavior['1.1.0'] = { dialect: 'postgres', pending: true }
  await f.configure()
  expect(await f.run(['update', '--backup-confirmed', '--yes'], '1.1.0')).toBe(0)
  expect(await readCurrent(f.home)).toMatchObject({ current: '1.1.0', previous: '1.0.0' })
  expect(f.fetcher).not.toHaveBeenCalled()
})

it('默认先升最新兼容版本；检查标注高协议，显式目标和无兼容版本都交给 prepare 说明', async () => {
  const f = await setup()
  const target = signedManifest(releaseZip('2.0.0'), '2.0.0', { managerProtocol: 2 })
  const middle = signedManifest(releaseZip('1.1.0'))
  const older = signedManifest(releaseZip('1.0.1'), '1.0.1')
  const releases = [
    target.body.releases[0],
    { ...older.body.releases[0], key: 'older' },
    { ...middle.body.releases[0], key: 'middle' },
  ]
  const zip = releaseZip('1.1.0')
  const options = {
    ...f.options,
    manager: {
      keys: { ...target.keys, middle: middle.keys.test, older: older.keys.test },
      fetch: (input: Parameters<typeof fetch>[0]) =>
        Promise.resolve(requestUrl(input) === MANIFEST_URL ? Response.json({ schema: 1, releases }) : zipResponse(zip)),
    },
  }
  const run = (args: string[]) => runManagementCommand(f.home, '1.0.0', args, options)
  expect(await run(['update', '--check'])).toBe(0)
  const lines = f.output.mock.calls.at(-1)![0].split('\n')
  expect(lines[0]).toMatch(/^2.0.0.*（要求更新的管理进程）$/)
  expect(lines[1]).not.toContain('要求更新的管理进程')
  expect(await run(['update', '--check', '--json'])).toBe(0)
  expect(JSON.parse(f.output.mock.calls.at(-1)![0])).toMatchObject([
    { version: '2.0.0', managerProtocol: 2 },
    { version: '1.1.0', managerProtocol: 1 },
    { version: '1.0.1', managerProtocol: 1 },
  ])
  expect(await run(['update', '--to', '2.0.0', '--yes'])).toBe(1)
  expect(f.error).toHaveBeenLastCalledWith(expect.stringContaining('先升级到 1.1.0，重启一次服务'))
  expect(await run(['update', '--yes'])).toBe(0)
  expect(f.output).toHaveBeenCalledWith('2.0.0 要求更新的管理进程，这次先升级到 1.1.0；重启一次服务以后再升级到 2.0.0')
  expect((await readCurrent(f.home))?.current).toBe('1.1.0')
  // 同一运行版本的管理进程仍要先重启，不能直接跳到高协议版本。
  expect(await run(['update', '--yes'])).toBe(1)
  expect(f.error).toHaveBeenLastCalledWith(
    expect.stringContaining('先重启一次服务，让新的管理进程生效，再升级到 2.0.0'),
  )
  await rm(join(f.home, 'manager.next'), { recursive: true })
  expect(await run(['update', '--yes'])).toBe(1)
  expect(f.error).toHaveBeenLastCalledWith(expect.stringContaining('一键升级做不到：覆盖解压它的 ZIP 来升级'))
})

it.each(['mysql', 'postgres'] as const)('%s 有迁移的在线回滚直接拒绝，--yes 也不能绕过', async (dialect) => {
  const f = await setup()
  await writeCurrent(f.home, {
    ...initialCurrent('1.1.0'),
    previous: '1.0.0',
    upgrades: { '1.1.0': { from: '1.0.0', migrations: true, dialect, backup: null } },
  })
  const rollback = vi.fn()
  const manager: Manager = {
    status: () => ({ current: '1.1.0', previous: '1.0.0', operation: null, prepared: null, lastResult: null }),
    check: vi.fn(),
    prepare: vi.fn(),
    prepareLocal: vi.fn(),
    apply: vi.fn(),
    cancel: vi.fn(),
    rollback,
  }
  const service = await createControl({ home: f.home, bundled: '1.1.0', manager })
  disposers.push(service.close)
  const confirm = vi.fn(() => Promise.resolve(true))
  for (const args of [['rollback'], ['rollback', '--yes']]) {
    expect(await runManagementCommand(f.home, '1.1.0', args, { ...f.options, isTTY: true, confirm })).toBe(1)
    expect(f.error).toHaveBeenLastCalledWith(expect.stringContaining('先停掉服务，用升级前的备份恢复数据库'))
  }
  expect(confirm).not.toHaveBeenCalled()
  expect(rollback).not.toHaveBeenCalled()
})

it.each(['mysql', 'postgres'] as const)(
  '%s 有迁移的离线回滚先提示恢复要求，再询问并核对目标数据库',
  async (dialect) => {
    const f = await setup()
    f.behavior['1.1.0'] = { dialect, pending: true }
    await f.configure()
    expect(await f.run(['update', '--yes', '--backup-confirmed'], '1.1.0')).toBe(0)
    f.behavior['1.0.0'] = { dialect, pending: true }
    await f.configure()
    const confirm = vi.fn(() => {
      expect(f.output).toHaveBeenLastCalledWith('服务停着、数据库已经用升级前的备份恢复了，才能继续')
      return Promise.resolve(true)
    })
    const run = () => runManagementCommand(f.home, '1.1.0', ['rollback'], { ...f.options, isTTY: true, confirm })
    expect(await run()).toBe(1)
    expect((await readCurrent(f.home))?.current).toBe('1.1.0')
    await writeFile(join(f.home, 'data/db.sqlite'), 'db:1.0.0')
    expect(await run()).toBe(0)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(f.output).toHaveBeenLastCalledWith('已切换到 1.0.0，启动服务即可')
    expect((await events(f.home)).some((event) => event.command === 'start')).toBe(false)
  },
)
