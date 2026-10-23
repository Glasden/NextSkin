import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTestDirectory } from '@nextskin/db/testing'
import { afterEach, expect, test, vi } from 'vitest'
import { ConfigError } from '../config.ts'
import type { LauncherContext } from '../context.ts'
import { acquireDataLock } from '../lock.ts'
import { supervise } from '../supervisor.ts'
import { lockDataDirectory, run } from './start.ts'

vi.mock('../supervisor.ts', async (original) => ({
  ...(await original<typeof import('../supervisor.ts')>()),
  supervise: vi.fn(() => Promise.resolve(0)),
}))
vi.mock('../lock.ts', () => ({ acquireDataLock: vi.fn(() => Promise.resolve({ release: vi.fn() })) }))

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  // 有的用例改了 acquireDataLock 的返回值：恢复成 vi.mock 里的实现
  vi.resetAllMocks()
  for (const directory of directories.splice(0)) await removeTestDirectory(directory)
})

test.each(['same', 'different', 'missing'] as const)('start 检查发行目录版本：%s', async (state) => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-start-'))
  directories.push(root)
  await mkdir(join(root, 'server/apps/web'), { recursive: true })
  await writeFile(join(root, 'server/apps/web/server.js'), '')
  if (state !== 'missing') await writeFile(join(root, 'server/VERSION'), state === 'same' ? '0.0.0\n' : '9.9.9\n')
  vi.stubEnv('NEXTSKIN_ENV_FILE', join(root, 'absent.env'))
  vi.stubEnv('NEXTSKIN_SECRET', 'launcher-test-secret-at-least-32-characters')
  vi.stubEnv('NEXTSKIN_DATA_DIR', join(root, 'data'))
  vi.stubEnv('NEXTSKIN_DATABASE_URL', `sqlite:${join(root, 'site.sqlite')}`)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const context = { root, cwd: root, source: false, production: true, version: '0.0.0' }
  if (state === 'same') {
    expect(await run([], context)).toBe(0)
    expect(supervise).toHaveBeenCalledOnce()
    expect(acquireDataLock).toHaveBeenCalledOnce()
  } else {
    // main.ts 将 ConfigError 映射为退出 78；在加锁和拉起核心之前拒绝不完整的发行包。
    const error: unknown = await run([], context).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as Error).message).toContain(state === 'missing' ? '缺少版本标记' : 'server/ 版本 9.9.9')
    expect(acquireDataLock).not.toHaveBeenCalled()
    expect(supervise).not.toHaveBeenCalled()
  }
})

async function releaseRoot(): Promise<LauncherContext> {
  const root = await mkdtemp(join(tmpdir(), 'launcher-start-'))
  directories.push(root)
  await mkdir(join(root, 'server/apps/web'), { recursive: true })
  await writeFile(join(root, 'server/apps/web/server.js'), '')
  await writeFile(join(root, 'server/VERSION'), '0.0.0\n')
  vi.stubEnv('NEXTSKIN_ENV_FILE', join(root, 'absent.env'))
  vi.stubEnv('NEXTSKIN_SECRET', 'launcher-test-secret-at-least-32-characters')
  vi.stubEnv('NEXTSKIN_DATA_DIR', join(root, 'data'))
  vi.stubEnv('NEXTSKIN_DATABASE_URL', `sqlite:${join(root, 'site.sqlite')}`)
  return { root, cwd: root, source: false, production: true, version: '0.0.0' }
}

function stubParent(connected = true, ipc = true) {
  const parent = { connected, send: vi.fn<NonNullable<typeof process.send>>(() => true), channel: { unref: vi.fn() } }
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get(target, key) {
        if (key === 'send') return ipc ? parent.send : undefined
        if (key === 'connected') return parent.connected
        if (key === 'channel') return parent.channel
        return Reflect.get(target, key) as unknown
      },
    }),
  )
  return parent
}

function ipcListeners() {
  return ['message', 'disconnect', 'SIGTERM', 'SIGINT'].map((event) => process.listenerCount(event))
}

test('独立实例目录只改变配置和数据路径，发行检查和 server.js 仍使用程序目录', async () => {
  const context = await releaseRoot()
  const home = await mkdtemp(join(tmpdir(), 'launcher-home-'))
  directories.push(home)
  context.home = home
  vi.stubEnv('NEXTSKIN_ENV_FILE', undefined)
  vi.stubEnv('NEXTSKIN_DATA_DIR', undefined)
  vi.stubEnv('NEXTSKIN_DATABASE_URL', undefined)
  await writeFile(join(home, '.env'), 'NEXTSKIN_DATA_DIR=storage\nNEXTSKIN_DATABASE_URL=sqlite:db/site.sqlite\n')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await run([], context)).toBe(0)
  expect(acquireDataLock).toHaveBeenCalledWith(join(home, 'storage'))
  expect(vi.mocked(supervise).mock.calls[0]?.[0]).toMatchObject({
    serverJs: join(context.root, 'server/apps/web/server.js'),
    env: {
      NEXTSKIN_ENV_FILE: join(home, '.env'),
      NEXTSKIN_DATA_DIR: join(home, 'storage'),
      NEXTSKIN_DATABASE_URL: `sqlite:${join(home, 'db/site.sqlite')}`,
    },
  })
})

test.each(['shutdown', 'disconnect', 'disconnected'] as const)(
  '被监管时等锁收到 %s 就退出 0，不拉起核心',
  async (event) => {
    const context = await releaseRoot()
    vi.stubEnv('NEXTSKIN_MANAGED', '1')
    const parent = stubParent(event !== 'disconnected')
    vi.mocked(acquireDataLock).mockResolvedValue(null)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = ipcListeners()
    const started = run([], context)
    if (event !== 'disconnected') {
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('正被另一个服务使用')))
      for (const message of ['shutdown', {}, { nextskin: 'unknown' }, { nextskin: 'ready' }])
        process.emit('message', message, undefined)
      expect(ipcListeners().slice(0, 2)).toEqual(before.slice(0, 2).map((count) => count + 1))
      if (event === 'shutdown') process.emit('message', { nextskin: 'shutdown' }, undefined)
      else {
        parent.connected = false
        process.emit('disconnect')
      }
    }
    expect(await started).toBe(0)
    expect(supervise).not.toHaveBeenCalled()
    expect(parent.send).not.toHaveBeenCalled()
    expect(parent.channel.unref).toHaveBeenCalledOnce()
    expect(ipcListeners()).toEqual(before)
  },
)

test.each([
  { managed: undefined, ipc: true },
  { managed: '0', ipc: true },
  { managed: '1', ipc: false },
])('不满足监管条件时不监听或发送 IPC：%j', async ({ managed, ipc }) => {
  const context = await releaseRoot()
  vi.stubEnv('NEXTSKIN_MANAGED', managed)
  const parent = stubParent(true, ipc)
  await writeFile(join(context.root, 'absent.env'), 'NEXTSKIN_MANAGED=1\n')
  const before = ipcListeners()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(supervise).mockImplementation((options) => {
    expect(options.stopOn).toBeUndefined()
    expect(options.onReady).toBeUndefined()
    expect(ipcListeners()).toEqual(before)
    return Promise.resolve(0)
  })
  expect(await run([], context)).toBe(0)
  expect(parent.send).not.toHaveBeenCalled()
  expect(parent.channel.unref).not.toHaveBeenCalled()
  expect(ipcListeners()).toEqual(before)
})

test('交给 supervise 时发现父进程已断线，不拉起核心并释放锁和监听器', async () => {
  const context = await releaseRoot()
  vi.stubEnv('NEXTSKIN_MANAGED', '1')
  const parent = stubParent()
  const before = ipcListeners()
  const lock = { release: vi.fn() }
  vi.mocked(acquireDataLock).mockResolvedValue(lock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const actual = await vi.importActual<typeof import('../supervisor.ts')>('../supervisor.ts')
  vi.mocked(supervise).mockImplementation((options) => {
    expect(ipcListeners()).toEqual(before)
    parent.connected = false
    return actual.supervise(options)
  })
  expect(await run([], context)).toBe(0)
  expect(parent.send).not.toHaveBeenCalled()
  expect(parent.channel.unref).toHaveBeenCalledTimes(2)
  expect(lock.release).toHaveBeenCalledOnce()
  expect(ipcListeners()).toEqual(before)
})

test.each(['shutdown', 'disconnect', 'timeout', 'restart'] as const)(
  '被监管时核心 ready 后转发，%s 走现有停止流程',
  async (event) => {
    const context = await releaseRoot()
    const state = join(context.root, 'runs')
    await copyFile(new URL('../fixtures/core.mjs', import.meta.url), join(context.root, 'server/apps/web/server.js'))
    vi.stubEnv('NEXTSKIN_MANAGED', '1')
    vi.stubEnv('NEXTSKIN_HOST', '127.0.0.1')
    vi.stubEnv('NEXTSKIN_PORT', '4567')
    vi.stubEnv('LAUNCHER_TEST_STATE', state)
    vi.stubEnv(
      'LAUNCHER_TEST_PLAN',
      JSON.stringify(
        event === 'restart'
          ? [{ ready: true, exitAfter: 5 }, { ready: true }]
          : [{ ready: true, ignoreShutdown: event === 'timeout' }],
      ),
    )
    const parent = stubParent()
    const before = ipcListeners()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const actual = await vi.importActual<typeof import('../supervisor.ts')>('../supervisor.ts')
    vi.mocked(supervise).mockImplementation((options) =>
      actual.supervise({ ...options, shutdownTimeout: 50, initialDelay: 10 }),
    )
    const started = run([], context)
    try {
      await vi.waitFor(() =>
        expect(parent.send).toHaveBeenCalledWith(
          { nextskin: 'ready', version: context.version, host: '127.0.0.1', port: 4567 },
          expect.any(Function),
        ),
      )
      if (event === 'restart') await vi.waitFor(() => expect(parent.send).toHaveBeenCalledTimes(2))
      expect(ipcListeners().slice(0, 2)).toEqual(before.slice(0, 2).map((count) => count + 1))
      for (const message of ['shutdown', {}, { nextskin: 'unknown' }]) process.emit('message', message, undefined)
      if (event === 'disconnect') {
        parent.connected = false
        process.emit('disconnect')
      }
    } finally {
      process.emit('message', { nextskin: 'shutdown' }, undefined)
      await started
    }
    expect(await started).toBe(0)
    expect(await readFile(state + '.events', 'utf8')).toBe('shutdown\n')
    expect(await readFile(state, 'utf8')).toBe(event === 'restart' ? '2' : '1')
    expect(parent.channel.unref).toHaveBeenCalledTimes(2)
    expect(ipcListeners()).toEqual(before)
  },
)

test('每次核心 ready 都转发，通道断开和发送失败不影响停止和锁释放', async () => {
  const context = await releaseRoot()
  vi.stubEnv('NEXTSKIN_MANAGED', '1')
  const parent = stubParent()
  const before = ipcListeners()
  const lock = { release: vi.fn() }
  vi.mocked(acquireDataLock).mockResolvedValue(lock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(supervise).mockImplementation((options) => {
    options.onReady?.()
    options.onReady?.()
    expect(parent.send).toHaveBeenCalledTimes(2)
    parent.connected = false
    options.onReady?.()
    expect(parent.send).toHaveBeenCalledTimes(2)
    parent.connected = true
    parent.send.mockImplementationOnce(() => {
      throw new Error('channel closed')
    })
    expect(() => options.onReady?.()).not.toThrow()
    const callback = parent.send.mock.calls[0]?.[1] as unknown as (error: Error) => void
    expect(() => callback(new Error('channel closed'))).not.toThrow()
    return Promise.resolve(0)
  })
  expect(await run([], context)).toBe(0)
  expect(lock.release).toHaveBeenCalledOnce()
  expect(ipcListeners()).toEqual(before)
})

test('等锁时收到停止信号就放弃，不拉起核心，退出 0，信号处理函数都收回', async () => {
  const context = await releaseRoot()
  vi.mocked(acquireDataLock).mockResolvedValue(null)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const before = process.listenerCount('SIGTERM')
  const started = run([], context)
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('正被另一个服务使用')))
  expect(process.listenerCount('SIGTERM')).toBe(before + 1)
  // 直接调用 start 注册的处理函数：process.emit 会连带触发测试框架自己的处理函数
  const at = Date.now()
  process.listeners('SIGTERM').at(-1)?.('SIGTERM')
  expect(await started).toBe(0)
  expect(Date.now() - at).toBeLessThan(400)
  expect(supervise).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledWith('[nextskin] 收到停止信号，没有启动核心')
  expect(process.listenerCount('SIGTERM')).toBe(before)
})

test('交给 supervise 之前放开自己的信号处理函数', async () => {
  const context = await releaseRoot()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const before = process.listenerCount('SIGTERM')
  vi.mocked(supervise).mockImplementation(() => {
    expect(process.listenerCount('SIGTERM')).toBe(before)
    return Promise.resolve(0)
  })
  expect(await run([], context)).toBe(0)
  expect(supervise).toHaveBeenCalledOnce()
})

test('数据目录被占用时等它放开再加锁，超时退出 78', async () => {
  const lock = { release: vi.fn() }
  vi.mocked(acquireDataLock).mockResolvedValueOnce(null).mockResolvedValueOnce(lock)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await lockDataDirectory('/data', 5_000)).toBe(lock)
  expect(acquireDataLock).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenCalledWith('[nextskin] 数据目录 /data 正被另一个服务使用，等它退出，最多 5 秒')

  vi.mocked(acquireDataLock).mockResolvedValue(null)
  const error: unknown = await lockDataDirectory('/data', 1_000).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(ConfigError)
  expect((error as Error).message).toContain('已经有服务在用')
  expect(log).toHaveBeenCalledTimes(2)
})
