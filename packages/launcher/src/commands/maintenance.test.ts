import { openCore } from '@nextskin/domain'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { CommandContext, ReadCommandContext } from '../context.ts'
import { run } from './maintenance.ts'

vi.mock('@nextskin/domain', () => ({ openCore: vi.fn() }))
const readSettings = vi.fn()
const setMaintenanceAsSystem = vi.fn()
const close = vi.fn()
const context = { config: {} } as CommandContext
const read = vi.fn<ReadCommandContext>()
let log: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetAllMocks()
  read.mockResolvedValue(context)
  readSettings.mockResolvedValue({ 'maintenance.enabled': false, 'maintenance.blockProtocols': false })
  setMaintenanceAsSystem.mockResolvedValue({ changed: true })
  close.mockResolvedValue(undefined)
  vi.mocked(openCore).mockResolvedValue({
    core: { settings: { read: readSettings }, admin: { setMaintenanceAsSystem } },
    close,
  } as unknown as Awaited<ReturnType<typeof openCore>>)
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

test.each([
  [false, false, '维护模式：未开启'],
  [false, true, '维护模式：未开启'],
  [true, false, '维护模式：已开启（游戏服务照常）'],
  [true, true, '维护模式：已开启（游戏服务已停用）'],
] as const)('无参数读取现状：enabled=%s blockProtocols=%s', async (enabled, blockProtocols, message) => {
  readSettings.mockResolvedValue({ 'maintenance.enabled': enabled, 'maintenance.blockProtocols': blockProtocols })
  expect(await run([], read)).toBe(0)
  expect(openCore).toHaveBeenCalledExactlyOnceWith(context.config, { startJobs: false })
  expect(readSettings).toHaveBeenCalledExactlyOnceWith(['maintenance.enabled', 'maintenance.blockProtocols'])
  expect(log).toHaveBeenCalledExactlyOnceWith(message)
  expect(setMaintenanceAsSystem).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

test.each([
  ['on', true, '维护模式已开启：除了管理员，别人打开站点只能看到维护页。'],
  ['on', false, '维护模式已经开启，没有改动。'],
  ['off', true, '维护模式已关闭。'],
  ['off', false, '维护模式已经关闭，没有改动。'],
] as const)('%s changed=%s 通过领域用例开关并打印结果', async (arg, changed, message) => {
  setMaintenanceAsSystem.mockResolvedValue({ changed })
  expect(await run(['--', arg], read)).toBe(0)
  expect(setMaintenanceAsSystem).toHaveBeenCalledExactlyOnceWith(arg === 'on')
  expect(readSettings).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledExactlyOnceWith(message)
  expect(close).toHaveBeenCalledOnce()
})

test.each([['invalid'], ['on', 'off'], ['--help']])('参数错误 %j 不打开核心', async (...args) => {
  expect(await run(args, read)).toBe(1)
  expect(error).toHaveBeenCalledExactlyOnceWith('用法：nextskin maintenance [on|off]')
  expect(read).not.toHaveBeenCalled()
  expect(openCore).not.toHaveBeenCalled()
})

test.each(['open', 'read', 'write', 'close'] as const)(
  '%s 失败时退出 1，不回显原始错误，打开的核心总会关闭',
  async (failure) => {
    const sensitive = new Error('连接串和令牌不可回显')
    if (failure === 'open') vi.mocked(openCore).mockRejectedValue(sensitive)
    if (failure === 'read') readSettings.mockRejectedValue(sensitive)
    if (failure === 'write') setMaintenanceAsSystem.mockRejectedValue(sensitive)
    if (failure === 'close') close.mockRejectedValue(sensitive)
    expect(await run(failure === 'write' ? ['on'] : [], read)).toBe(1)
    expect(error).toHaveBeenCalledExactlyOnceWith('维护模式命令执行失败，请检查环境变量和数据库是否可用。')
    expect(close).toHaveBeenCalledTimes(failure === 'open' ? 0 : 1)
  },
)
