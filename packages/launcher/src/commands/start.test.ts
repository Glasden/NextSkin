import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
