import type { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, readFile, rm, writeFile, type chown } from 'node:fs/promises'
import { join } from 'node:path'
import { createManager } from './pipeline.ts'
import { LauncherSupervisor } from './process.ts'
import { selectVersion, selectedVersion, start } from './start.ts'
import { dispatch } from './main.ts'
import { fixture, events, contains, healthTimeout } from './fixtures.ts'
import { acquireLock } from './lock.ts'
import { initialCurrent, readCurrent, writeCurrent } from './state.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})
async function setup() {
  const f = await fixture(['1.0.0', '1.1.0', '0.9.0'])
  disposers.push(f.dispose)
  const supervisor = new LauncherSupervisor(f.home, {
    healthTimeout,
    healthInterval: 10,
    shutdownTimeout: 100,
    log: vi.fn(),
  })
  disposers.push(() => supervisor.shutdown())
  const manager = await createManager({ home: f.home, bundled: '1.1.0', supervisor, log: vi.fn() })
  return { ...f, manager, supervisor }
}
async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('选版本', () => {
  it('全新安装写完整指针；正常启动不改指针', async () => {
    const f = await setup()
    await rm(join(f.home, 'releases/current.json'))
    expect(await selectVersion({ ...f, bundled: '1.1.0' })).toBe('1.1.0')
    expect(await readCurrent(f.home)).toEqual(initialCurrent('1.1.0'))
    const before = await readFile(join(f.home, 'releases/current.json'), 'utf8')
    expect(await selectVersion({ ...f, bundled: '1.1.0' })).toBe('1.1.0')
    expect(await readFile(join(f.home, 'releases/current.json'), 'utf8')).toBe(before)
  })
  it('覆盖新 ZIP 从预检切换，成功后记录 bundled', async () => {
    const f = await setup()
    expect(await selectVersion({ ...f, bundled: '1.1.0' })).toBe('1.1.0')
    expect(await readCurrent(f.home)).toMatchObject({ current: '1.1.0', previous: '1.0.0', bundled: '1.1.0' })
    expect((await events(f.home)).map((e) => e.command)).not.toContain('download')
    expect(f.manager.status().lastResult).toMatchObject({ kind: 'manual', result: 'success' })
  })
  it('手动新版本预检失败仍记录 bundled，下次启动不重试', async () => {
    const f = await setup()
    f.behavior['1.1.0'] = { fail: 'secret' }
    await f.configure()
    expect(await selectVersion({ ...f, bundled: '1.1.0', log: vi.fn() })).toBe('1.0.0')
    expect(await readCurrent(f.home)).toMatchObject({ current: '1.0.0', bundled: '1.1.0', failed: [] })
    const before = (await events(f.home)).length
    await selectVersion({ ...f, bundled: '1.1.0' })
    expect((await events(f.home)).length).toBe(before)
  })
  it.each(['0.9.0', '1.0.0'])('解压较旧或相等的 %s，只改 bundled', async (bundled) => {
    const f = await setup()
    await writeCurrent(f.home, { ...initialCurrent('1.0.0'), bundled: '0.8.0' })
    const log = vi.fn()
    expect(await selectVersion({ ...f, bundled, log })).toBe('1.0.0')
    expect((await readCurrent(f.home))?.bundled).toBe(bundled)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('解压的版本比当前旧'))
    expect(await events(f.home)).toEqual([])
  })
  it('旧布局成功时 previous=null，删除旧程序', async () => {
    const f = await setup()
    await rm(join(f.home, 'releases/current.json'))
    await mkdir(join(f.home, 'server'))
    await mkdir(join(f.home, 'cli'))
    await writeFile(join(f.home, 'server/VERSION'), '0.7.0')
    expect(await selectVersion({ ...f, bundled: '1.1.0' })).toBe('1.1.0')
    expect(await readCurrent(f.home)).toMatchObject({ current: '1.1.0', previous: null })
    expect(f.manager.status().lastResult).toMatchObject({ kind: 'legacy', from: '0.7.0' })
    expect(await exists(join(f.home, 'server'))).toBe(false)
    expect(await exists(join(f.home, 'cli'))).toBe(false)
  })
  it('旧布局 SQLite 迁移后健康失败先恢复库，保留旧目录并要求人工回退', async () => {
    const f = await setup()
    await rm(join(f.home, 'releases/current.json'))
    await mkdir(join(f.home, 'server'))
    await mkdir(join(f.home, 'cli'))
    await writeFile(join(f.home, 'server/VERSION'), '0.7.0')
    f.behavior['1.1.0'] = { pending: true, health: 503 }
    await f.configure()
    await expect(selectVersion({ ...f, bundled: '1.1.0' })).rejects.toMatchObject({
      exitCode: 78,
      message: contains('手工回退'),
    })
    expect(await readFile(join(f.home, 'data/db.sqlite'), 'utf8')).toBe('original')
    expect(await exists(join(f.home, 'server'))).toBe(true)
    expect(await exists(join(f.home, 'cli'))).toBe(true)
    expect(await readCurrent(f.home)).toBeNull()
    expect(f.supervisor.running).toBe(false)
  })
  it('access 失败只读启动 current，无指针时使用自带版本', async () => {
    const f = await setup()
    const writable = () => Promise.reject(new Error('read-only'))
    const log = vi.fn()
    expect(await selectVersion({ ...f, bundled: '1.1.0', writable, log })).toBe('1.0.0')
    expect((await readCurrent(f.home))?.bundled).toBe('1.0.0')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('只读模式'))
    await rm(join(f.home, 'releases/current.json'))
    expect(await selectVersion({ ...f, bundled: '1.1.0', writable, log })).toBe('1.1.0')
    expect(await readCurrent(f.home)).toBeNull()
  })
  it('写 current.json 失败退回只读，不执行预检和停止', async () => {
    const f = await setup()
    const log = vi.fn()
    expect(
      await selectVersion({
        ...f,
        bundled: '1.1.0',
        writeCurrent: () => Promise.reject(new Error('permissions')),
        log,
      }),
    ).toBe('1.0.0')
    expect(await events(f.home)).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('只读模式'))
  })
  it('off 模式和普通命令只读选版本，在本进程加载，保持 argv', async () => {
    const f = await setup()
    await mkdir(join(f.home, 'manager.next'))
    await writeFile(join(f.home, 'manager.next/VERSION'), '9.0.0')
    const load = vi.fn<(version: string) => Promise<void>>(() => Promise.resolve())
    const argv = [...process.argv]
    const before = await readFile(join(f.home, 'releases/current.json'), 'utf8')
    expect(
      await start({ home: f.home, bundled: '1.1.0', env: { NEXTSKIN_MANAGER: 'off' }, importLauncher: load }),
    ).toBe(0)
    expect(load).toHaveBeenCalledExactlyOnceWith('1.0.0')
    expect(await exists(join(f.home, 'releases/manager.lock'))).toBe(false)
    expect(await readFile(join(f.home, 'releases/current.json'), 'utf8')).toBe(before)
    const oldHome = process.env.NEXTSKIN_HOME
    try {
      expect(await dispatch(f.home, '1.1.0', 'set-password', load)).toBe(0)
      expect(process.env.NEXTSKIN_HOME).toBe(f.home)
      expect(process.argv).toEqual(argv)
    } finally {
      if (oldHome === undefined) delete process.env.NEXTSKIN_HOME
      else process.env.NEXTSKIN_HOME = oldHome
    }
    expect(await selectedVersion(f.home, '1.1.0')).toBe('1.0.0')
    await rm(join(f.home, 'releases/current.json'))
    expect(await selectedVersion(f.home, '1.1.0')).toBe('1.1.0')
  })
  it('管理进程等待锁时收到 SIGTERM 放弃，不启动任何版本', async () => {
    const f = await setup()
    const lock = (await acquireLock(join(f.home, 'releases/manager.lock')))!
    disposers.push(() => Promise.resolve(lock.release()))
    let waiting!: () => void
    const entered = new Promise<void>((r) => {
      waiting = r
    })
    const starting = start({
      home: f.home,
      bundled: '1.0.0',
      log: () => {
        waiting()
      },
    })
    await entered
    process.emit('SIGTERM', 'SIGTERM')
    expect(await starting).toBe(0)
    expect(await events(f.home)).toEqual([])
  })
  it('start 监管退出 0，持锁到启动器退出，释放锁', async () => {
    const f = await setup()
    f.behavior['1.0.0'] = { exit: 0 }
    await f.configure()
    expect(await start({ home: f.home, bundled: '1.0.0', log: vi.fn() })).toBe(0)
    const lock = await acquireLock(join(f.home, 'releases/manager.lock'))
    expect(lock).not.toBeNull()
    lock?.release()
  })
})

it('第二次 SIGINT 强杀不响应 shutdown 的启动器', async () => {
  const f = await setup()
  f.behavior['1.0.0'] = { ignoreShutdown: true }
  await f.configure()
  const { spawn } = await import('node:child_process')
  const kills: string[] = []
  const spawnChild = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    const kill = child.kill.bind(child)
    child.kill = (signal) => {
      kills.push(String(signal))
      return kill(signal)
    }
    child.once('message', () => {
      process.emit('SIGINT', 'SIGINT')
      setTimeout(() => process.emit('SIGINT', 'SIGINT'), 10)
    })
    return child
  }) as typeof spawn
  expect(
    await start({ home: f.home, bundled: '1.0.0', spawn: spawnChild, shutdownTimeout: 10_000, log: vi.fn() }),
  ).toBe(0)
  expect(kills).toEqual(['SIGKILL'])
})

it('手动升级 MySQL 失败且旧版本打不开时退出，不再次偷偷启动旧版', async () => {
  const f = await setup()
  f.behavior['1.1.0'] = { dialect: 'mysql', migrateFail: true }
  f.behavior['1.0.0'] = { dialect: 'mysql', health: 503 }
  await f.configure()
  await expect(selectVersion({ ...f, bundled: '1.1.0', log: vi.fn() })).rejects.toThrow('用升级前的备份恢复数据库')
  expect(f.supervisor.running).toBe(false)
})

it.each(['mysql', 'postgres'] as const)(
  '手动解压 %s 有迁移时保留 prepared，不尝试切换也不标记失败',
  async (dialect) => {
    const f = await setup()
    f.behavior['1.1.0'] = { dialect, pending: true }
    await f.configure()
    const log = vi.fn()
    expect(await selectVersion({ ...f, bundled: '1.1.0', log })).toBe('1.0.0')
    expect(f.manager.status().prepared?.tier).toBe('external-backup')
    expect(f.manager.status().lastResult).toBeNull()
    expect((await readCurrent(f.home))?.failed).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--backup-confirmed'))
    expect((await events(f.home)).some((e) => ['migrate', 'start'].includes(e.command))).toBe(false)
  },
)

it('dispatch 跳过 npm 多传的 --，help 先给管理命令再转发', async () => {
  const f = await setup()
  const argv = process.argv
  const oldHome = process.env.NEXTSKIN_HOME
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const load = vi.fn(() => {
    expect(log).toHaveBeenCalledWith(expect.stringContaining('update status'))
    return Promise.resolve()
  })
  try {
    process.argv = [process.execPath, 'nextskin.mjs', '--', 'help']
    expect(await dispatch(f.home, '1.0.0', undefined, load)).toBe(0)
    expect(load).toHaveBeenCalledWith('1.0.0')
  } finally {
    process.argv = argv
    if (oldHome === undefined) delete process.env.NEXTSKIN_HOME
    else process.env.NEXTSKIN_HOME = oldHome
    log.mockRestore()
  }
})

it('手动外部库迁移时 start 保留版本目录和 prepared，启动器得到控制通道', async () => {
  const f = await setup()
  f.behavior['1.1.0'] = { dialect: 'mysql', pending: true }
  await f.configure()
  const { spawn } = await import('node:child_process')
  const { controlRequest } = await import('./control.ts')
  let status: unknown
  let inspect: Promise<void> | undefined
  const spawnChild = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    if (args[1][1] === 'start') {
      const env = args[2].env!
      child.once('message', () => {
        inspect = (async () => {
          status = await controlRequest(env.NEXTSKIN_MANAGER_ADDRESS!, env.NEXTSKIN_MANAGER_TOKEN!, 'status', {})
          process.emit('SIGTERM', 'SIGTERM')
        })()
      })
    }
    return child
  }) as typeof spawn
  expect(await start({ home: f.home, bundled: '1.1.0', spawn: spawnChild, log: vi.fn() })).toBe(0)
  await inspect
  expect(status).toMatchObject({ current: '1.0.0', prepared: { version: '1.1.0' } })
  expect(await exists(join(f.home, 'releases/1.1.0/server/VERSION'))).toBe(true)
  expect(await exists(join(f.home, 'releases/manager.token'))).toBe(false)
})

it('只读模式不开控制通道、不向启动器传令牌', async () => {
  const f = await setup()
  f.behavior['1.0.0'] = { exit: 0 }
  await f.configure()
  const { spawn } = await import('node:child_process')
  let env: NodeJS.ProcessEnv | undefined
  const spawnChild = ((...args: Parameters<typeof spawn>) => {
    env = args[2].env
    return spawn(...args)
  }) as typeof spawn
  expect(
    await start({
      home: f.home,
      bundled: '1.1.0',
      spawn: spawnChild,
      writable: () => Promise.reject(new Error('readonly')),
      log: vi.fn(),
    }),
  ).toBe(0)
  expect(env?.NEXTSKIN_MANAGER_ADDRESS).toBeUndefined()
  expect(env?.NEXTSKIN_MANAGER_TOKEN).toBeUndefined()
  expect(await exists(join(f.home, 'releases/manager.token'))).toBe(false)
})

it.skipIf(process.platform === 'win32')('start 解析身份一次、打印一行并传给 supervisor 和控制 socket', async () => {
  const f = await setup()
  f.behavior['1.0.0'] = { exit: 0 }
  await f.configure()
  const { spawn } = await import('node:child_process')
  const identity = vi.fn<typeof execFileSync>().mockReturnValueOnce('1234\n').mockReturnValueOnce('5678\n')
  const ownership = vi.fn<typeof chown>().mockResolvedValue(undefined)
  const calls: Parameters<typeof spawn>[2][] = []
  const spawnChild = ((...args: Parameters<typeof spawn>) => {
    calls.push(args[2])
    const actual = { ...args[2] }
    delete actual.uid
    delete actual.gid
    return spawn(args[0], args[1], actual)
  }) as typeof spawn
  const log = vi.fn()
  expect(
    await start({
      home: f.home,
      bundled: '1.0.0',
      env: { ...process.env, NEXTSKIN_RUN_AS: 'nextskin' },
      getuid: () => 0,
      execFileSync: identity,
      spawn: spawnChild,
      chown: ownership,
      log,
    }),
  ).toBe(0)
  expect(identity).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenCalledWith('[nextskin] 以 nextskin（1234/5678）运行服务')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.uid).toBe(1234)
  expect(calls[0]?.gid).toBe(5678)
  if (process.platform !== 'win32') expect(ownership.mock.calls[0]?.slice(1)).toEqual([0, 5678])
  expect(ownership.mock.calls.some((call) => String(call[0]).endsWith('manager.lock'))).toBe(false)
})

it('不能把需要降权的 RUN_AS 静默用于 off 的进程内加载', async () => {
  const f = await setup()
  const load = vi.fn(() => Promise.resolve())
  await expect(
    start({
      home: f.home,
      bundled: '1.0.0',
      env: { NEXTSKIN_MANAGER: 'off' },
      runAs: { name: 'nextskin', uid: 1234, gid: 5678 },
      importLauncher: load,
    }),
  ).rejects.toMatchObject({ exitCode: 78 })
  expect(load).not.toHaveBeenCalled()
})

it('转给启动器的普通命令不解析 RUN_AS，保持管理员选择的运行身份', async () => {
  const f = await setup()
  const previous = process.env.NEXTSKIN_RUN_AS
  const oldHome = process.env.NEXTSKIN_HOME
  const load = vi.fn(() => Promise.resolve())
  try {
    process.env.NEXTSKIN_RUN_AS = 'not/a/user'
    expect(await dispatch(f.home, '1.0.0', 'doctor', load)).toBe(0)
    expect(load).toHaveBeenCalledExactlyOnceWith('1.0.0')
  } finally {
    if (previous === undefined) delete process.env.NEXTSKIN_RUN_AS
    else process.env.NEXTSKIN_RUN_AS = previous
    if (oldHome === undefined) delete process.env.NEXTSKIN_HOME
    else process.env.NEXTSKIN_HOME = oldHome
  }
})

it('旧布局 PostgreSQL 有迁移时退出 78 并给出离线确认命令，不执行 apply', async () => {
  const f = await setup()
  await rm(join(f.home, 'releases/current.json'))
  await mkdir(join(f.home, 'server'))
  await mkdir(join(f.home, 'cli'))
  await writeFile(join(f.home, 'server/VERSION'), '0.9.0')
  f.behavior['1.1.0'] = { dialect: 'postgres', pending: true }
  await f.configure()
  await expect(selectVersion({ ...f, bundled: '1.1.0' })).rejects.toMatchObject({
    exitCode: 78,
    message: contains('--backup-confirmed'),
  })
  expect(await exists(join(f.home, 'server/VERSION'))).toBe(true)
  expect(await exists(join(f.home, 'cli'))).toBe(true)
  expect((await events(f.home)).some((e) => e.command === 'migrate')).toBe(false)
  expect(await readCurrent(f.home)).toBeNull()
})

it('管理进程运行时拒绝 import，关闭后正常转给启动器', async () => {
  const f = await setup()
  const { createControl } = await import('./control.ts')
  const service = await createControl({ home: f.home, bundled: '1.0.0', manager: f.manager })
  disposers.push(service.close)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const load = vi.fn(() => Promise.resolve())
  const oldHome = process.env.NEXTSKIN_HOME
  try {
    expect(await dispatch(f.home, '1.0.0', 'import', load)).toBe(1)
    expect(load).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('NextSkin 正在运行（管理进程），先停掉服务再导入')
    await service.close()
    disposers.pop()
    expect(await dispatch(f.home, '1.0.0', 'import', load)).toBe(0)
    expect(load).toHaveBeenCalledWith('1.0.0')
  } finally {
    log.mockRestore()
    if (oldHome === undefined) delete process.env.NEXTSKIN_HOME
    else process.env.NEXTSKIN_HOME = oldHome
  }
})
