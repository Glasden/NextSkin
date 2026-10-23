import type { chown } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { LauncherSupervisor, healthUrl, stopSignals, runCommand } from './process.ts'
import { acquireLock, waitForLock } from './lock.ts'
import { fixture, events } from './fixtures.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})
async function setup() {
  const f = await fixture()
  disposers.push(f.dispose)
  return f
}

describe('监管启动器', () => {
  it.each([0, 78])('退出 %s 时不重启，向上传递退出码', async (code) => {
    const f = await setup()
    f.behavior['1.0.0'] = { exit: code }
    await f.configure()
    const supervisor = new LauncherSupervisor(f.home, { log: vi.fn() })
    disposers.push(() => supervisor.shutdown())
    await supervisor.start('1.0.0')
    expect(await supervisor.finished).toBe(code)
    expect((await events(f.home)).filter((e) => e.command === 'start')).toHaveLength(1)
  })
  it('崩溃后指数退避、有上限，稳定运行后复位', async () => {
    const f = await setup()
    f.behavior['1.0.0'] = { exit: 1 }
    await f.configure()
    const delays: number[] = []
    const supervisor = new LauncherSupervisor(f.home, {
      log: vi.fn(),
      initialDelay: 2,
      maxDelay: 5,
      sleep: async (ms) => {
        delays.push(ms)
        if (delays.length === 4) await supervisor.shutdown()
      },
    })
    disposers.push(() => supervisor.shutdown())
    await supervisor.start('1.0.0')
    expect(await supervisor.finished).toBe(0)
    expect(delays).toEqual([2, 4, 5, 5])
    f.behavior['1.0.0'] = { exitAfter: 25 }
    await f.configure()
    const reset: number[] = []
    const stable = new LauncherSupervisor(f.home, {
      log: vi.fn(),
      initialDelay: 2,
      maxDelay: 10,
      stableTime: 10,
      sleep: async (ms) => {
        reset.push(ms)
        if (reset.length === 2) await stable.shutdown()
      },
    })
    disposers.push(() => stable.shutdown())
    await stable.start('1.0.0')
    await stable.finished
    expect(reset).toEqual([2, 2])
  })
  it('停止只发送 IPC，继承实例目录并去掉 NEXTSKIN_MANAGER', async () => {
    const f = await setup()
    const supervisor = new LauncherSupervisor(f.home, {
      log: vi.fn(),
      env: { ...process.env, NEXTSKIN_MANAGER: 'off' },
    })
    disposers.push(() => supervisor.shutdown())
    await supervisor.start('1.0.0', true)
    await supervisor.shutdown()
    const all = await events(f.home)
    expect(all.find((e) => e.command === 'start')).toMatchObject({ managed: '1' })
    expect(all.find((e) => e.command === 'start')?.manager).toBeUndefined()
    expect(all.some((e) => e.command === 'shutdown')).toBe(true)
    expect(all.some((e) => e.command === 'signal')).toBe(false)
  })
  it('停止超时强杀，第二次 SIGINT 可以立即强杀', async () => {
    const f = await setup()
    f.behavior['1.0.0'] = { ignoreShutdown: true }
    await f.configure()
    const calls: string[] = []
    const spawnChild = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args)
      const kill = child.kill.bind(child)
      child.kill = (signal) => {
        calls.push(String(signal))
        return kill(signal)
      }
      return child
    }) as typeof spawn
    const supervisor = new LauncherSupervisor(f.home, { spawn: spawnChild, shutdownTimeout: 20, log: vi.fn() })
    disposers.push(() => supervisor.shutdown())
    await supervisor.start('1.0.0', true)
    await supervisor.shutdown()
    expect(calls).toEqual(['SIGKILL'])
    expect((await events(f.home)).some((e) => e.command === 'shutdown')).toBe(true)
    const second = new LauncherSupervisor(f.home, { shutdownTimeout: 10_000, log: vi.fn() })
    disposers.push(() => second.shutdown())
    await second.start('1.0.0', true)
    const stopped = second.shutdown()
    second.force()
    await stopped
    expect(second.running).toBe(false)
  })
  it('ready 以外的提前退出不能通过健康检查；映射 IPv6 通配地址', async () => {
    const f = await setup()
    f.behavior['1.0.0'] = { exit: 0 }
    await f.configure()
    const supervisor = new LauncherSupervisor(f.home, { log: vi.fn() })
    disposers.push(() => supervisor.shutdown())
    await expect(supervisor.start('1.0.0', true)).rejects.toThrow('之前退出')
    expect(healthUrl({ host: '::', port: 3000 })).toBe('http://[::1]:3000/api/health')
    expect(healthUrl({ host: '0.0.0.0', port: 3000 })).toBe('http://127.0.0.1:3000/api/health')
    expect(stopSignals).toContain('SIGINT')
  })
})

describe('管理进程和数据锁', () => {
  it('第二个实例等第一个释放再取得锁', async () => {
    const f = await setup()
    const path = join(f.home, 'releases/manager.lock')
    const first = (await acquireLock(path))!
    disposers.push(() => Promise.resolve(first.release()))
    expect(await acquireLock(path)).toBeNull()
    const waiting = waitForLock(path, { timeout: 500, interval: 5, log: vi.fn() })
    setTimeout(() => first.release(), 25)
    const second = await waiting
    expect(second).not.toBeNull()
    second?.release()
  })
  it('等待锁时收到停止信号放弃，超时明确失败', async () => {
    const f = await setup()
    const path = join(f.home, 'releases/manager.lock')
    const first = (await acquireLock(path))!
    disposers.push(() => Promise.resolve(first.release()))
    const controller = new AbortController()
    const waiting = waitForLock(path, { timeout: 500, signal: controller.signal, log: vi.fn() })
    setTimeout(() => controller.abort(), 10)
    expect(await waiting).toBeNull()
    await expect(waitForLock(path, { timeout: 5, interval: 1, log: vi.fn() })).rejects.toThrow('等待进程锁超时')
  })
  it('取得锁后刚好收到取消会立即释放', async () => {
    const f = await setup()
    const path = join(f.home, 'releases/manager.lock')
    const controller = new AbortController()
    expect(
      await waitForLock(path, {
        signal: controller.signal,
        acquire: async (file) => {
          const lock = await acquireLock(file)
          controller.abort()
          return lock
        },
      }),
    ).toBeNull()
    const after = await acquireLock(path)
    expect(after).not.toBeNull()
    after?.release()
  })
})

it('只有被监管的 start 获得控制地址和令牌，doctor、migrate 剔除继承值', async () => {
  const f = await setup()
  const envs: NodeJS.ProcessEnv[] = []
  const spawnChild = ((...args: Parameters<typeof spawn>) => {
    envs.push(args[2].env!)
    return spawn(...args)
  }) as typeof spawn
  const env = { ...process.env, NEXTSKIN_MANAGER_ADDRESS: 'inherited', NEXTSKIN_MANAGER_TOKEN: 'inherited' }
  const supervisor = new LauncherSupervisor(f.home, { spawn: spawnChild, env, log: vi.fn() })
  disposers.push(() => supervisor.shutdown())
  const control = { address: 'test-address', token: 'test-token' }
  supervisor.setControl(control)
  await supervisor.start('1.0.0', true)
  await supervisor.stop()
  for (const command of ['doctor', 'migrate']) await runCommand(f.home, '1.0.0', command, { spawn: spawnChild, env })
  expect(envs[0]).toMatchObject({ NEXTSKIN_MANAGER_ADDRESS: control.address, NEXTSKIN_MANAGER_TOKEN: control.token })
  for (const value of envs.slice(1)) {
    expect(value.NEXTSKIN_MANAGER_ADDRESS).toBeUndefined()
    expect(value.NEXTSKIN_MANAGER_TOKEN).toBeUndefined()
  }
})

it.each([false, true])('start、doctor、migrate 的 uid/gid 和用户环境（分离=%s）', async (separated) => {
  const f = await setup()
  f.behavior['1.0.0'] = { exit: 0 }
  await f.configure()
  const received: Parameters<typeof spawn>[2][] = []
  const spawnChild = ((...args: Parameters<typeof spawn>) => {
    received.push(args[2])
    // 非 root 测试只验证边界上的选项；假启动器仍以测试用户真实运行。
    const actual = { ...args[2] }
    delete actual.uid
    delete actual.gid
    return spawn(args[0], args[1], actual)
  }) as typeof spawn
  const runAs = separated ? { name: 'nextskin', uid: 1234, gid: 5678 } : undefined
  const env = { ...process.env, HOME: '/test/admin', USER: 'admin', LOGNAME: 'admin' }
  const runtime = { runAs, env, spawn: spawnChild, log: vi.fn() }
  const supervisor = new LauncherSupervisor(f.home, runtime)
  disposers.push(() => supervisor.shutdown())
  await supervisor.start('1.0.0')
  expect(await supervisor.finished).toBe(0)
  for (const command of ['doctor', 'migrate']) await runCommand(f.home, '1.0.0', command, runtime)
  expect(received).toHaveLength(3)
  for (const value of received) {
    expect(Object.hasOwn(value, 'uid')).toBe(separated)
    expect(Object.hasOwn(value, 'gid')).toBe(separated)
    expect(value.uid).toBe(runAs?.uid)
    expect(value.gid).toBe(runAs?.gid)
    expect(value.env?.HOME).toBe(separated ? undefined : '/test/admin')
    expect(value.env?.USER).toBe(separated ? undefined : 'admin')
    expect(value.env?.LOGNAME).toBe(separated ? undefined : 'admin')
  }
})

it.skipIf(process.platform === 'win32')(
  '新建数据锁归服务用户，复用锁不改归属；真实 SQLite 持锁及释放均无旁路文件',
  async () => {
    const f = await setup()
    const { readdir, stat } = await import('node:fs/promises')
    const file = join(f.home, 'data/nextskin.lock')
    const ownership = vi.fn<typeof chown>().mockResolvedValue(undefined)
    const options = { runAs: { name: 'nextskin', uid: 1234, gid: 5678 }, chown: ownership }
    const first = (await acquireLock(file, options))!
    disposers.push(() => Promise.resolve(first.release()))
    expect(ownership.mock.calls).toEqual([[file, 1234, 5678]])
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const files = ['db.sqlite', 'nextskin.lock']
    expect((await readdir(join(f.home, 'data'))).sort()).toEqual(files)
    expect(await acquireLock(file, options)).toBeNull()
    first.release()
    expect((await readdir(join(f.home, 'data'))).sort()).toEqual(files)
    const second = (await acquireLock(file, options))!
    second.release()
    expect(ownership).toHaveBeenCalledTimes(1)
  },
)

it('新建锁的 chown 失败时删除空文件，不能留下 root 的锁阻挡服务', async () => {
  const f = await setup()
  const { access } = await import('node:fs/promises')
  const file = join(f.home, 'data/nextskin.lock')
  await expect(
    acquireLock(file, {
      runAs: { name: 'nextskin', uid: 1234, gid: 5678 },
      chown: vi.fn<typeof chown>().mockRejectedValue(new Error('denied')),
    }),
  ).rejects.toThrow('denied')
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform === 'win32')('内存 journal 的数据锁仍阻止其他进程启动，释放后启动器能正常打开', async () => {
  const f = await setup()
  const lock = (await acquireLock(join(f.home, 'data/nextskin.lock'), {
    runAs: { name: 'nextskin', uid: 1234, gid: 5678 },
    chown: vi.fn<typeof chown>().mockResolvedValue(undefined),
  }))!
  disposers.push(() => Promise.resolve(lock.release()))
  const supervisor = new LauncherSupervisor(f.home, { log: vi.fn(), healthInterval: 10, healthTimeout: 1000 })
  disposers.push(() => supervisor.shutdown())
  await expect(supervisor.start('1.0.0', true)).rejects.toThrow('78')
  await supervisor.stop()
  lock.release()
  await supervisor.start('1.0.0', true)
  expect(supervisor.running).toBe(true)
})
