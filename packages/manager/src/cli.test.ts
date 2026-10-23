import type { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile, type chown } from 'node:fs/promises'
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
    expect(f.output.mock.calls.flat().join('\n')).toContain('先用升级前的备份恢复数据库，再确认库已经恢复到升级之前')
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
    const options = {
      ...f.options,
      manager: {
        ...f.options.manager,
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
    expect(f.error.mock.calls.filter((call) => call[0] === '[nextskin] 以 nextskin（1234/5678）运行服务')).toHaveLength(
      2,
    )
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
