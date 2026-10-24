import { ManagerError } from './types.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, readFile, rm, stat, type chown } from 'node:fs/promises'
import { createConnection, Socket } from 'node:net'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { MANAGER_PROTOCOL } from '@nextskin/updates'
import { controlAddress, controlRequest, createControl, managerStatus, redactPaths } from './control.ts'
import { createManager } from './pipeline.ts'
import { fixture } from './fixtures.ts'
import { initialCurrent, writeCurrent } from './state.ts'
import type { InternalManagerStatus, Manager, ManagerStatus, Preflight } from './types.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})
async function setup(writable = true) {
  const f = await fixture()
  disposers.push(f.dispose)
  const state: InternalManagerStatus = {
    current: '1.0.0',
    previous: null,
    operation: null,
    prepared: null,
    lastResult: null,
  }
  const manager: Manager = {
    status: () => structuredClone(state),
    check: vi.fn(() => Promise.resolve([])),
    prepare: vi.fn(() => Promise.resolve(preflight)),
    prepareLocal: vi.fn(() => Promise.resolve(preflight)),
    apply: vi.fn(),
    rollback: vi.fn(),
    cancel: vi.fn(),
  }
  const service = await createControl({ home: f.home, bundled: '1.1.0', manager, writable })
  disposers.push(service.close)
  const call = (method: string, params: Record<string, unknown> = {}) =>
    controlRequest(service.address, service.token, method, params)
  return { ...f, service, state, manager, call }
}
const preflight: Preflight = {
  version: '1.1.0',
  dataDirectory: '/private/data',
  sqliteFile: '/private/db.sqlite',
  dialect: 'mariadb',
  pendingCore: ['c1'],
  pendingPlugins: [{ plugin: 'p', migrations: ['p1', 'p2'] }],
  incompatiblePlugins: [{ id: 'old', api: '0' }],
  tier: 'external-backup',
}
function raw(address: string, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address)
    let response = ''
    socket.on('data', (chunk) => {
      response += String(chunk)
    })
    socket.once('connect', () => socket.write(data))
    socket.once('error', reject)
    socket.once('close', () => resolve(response))
  })
}

describe('控制通道的信任边界', () => {
  it('错误令牌、额外字段、类型、未知方法都拒绝', async () => {
    const f = await setup()
    await expect(controlRequest(f.service.address, 'wrong', 'status', {})).rejects.toMatchObject({
      code: 'unauthorized',
    })
    const base = { token: f.service.token, method: 'status', params: {} }
    for (const body of [
      null,
      { ...base, extra: true },
      { ...base, token: 1 },
      { ...base, params: { extra: true } },
      { ...base, params: [] },
      { ...base, method: 'unknown' },
      { ...base, method: 'prepare', params: { version: '../bad' } },
      { ...base, method: 'apply', params: { version: '1.1.0', backupConfirmed: 'yes' } },
      { ...base, method: 'rollback', params: { confirmed: 1 } },
      { ...base, method: 'cancel', params: { extra: 1 } },
    ]) {
      expect(JSON.parse(await raw(f.service.address, JSON.stringify(body) + '\n'))).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      })
    }
    expect(JSON.parse(await raw(f.service.address, '{bad}\n'))).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })
  it('超长行和五秒未完成的半行直接断开', async () => {
    const f = await setup()
    expect(await raw(f.service.address, 'x'.repeat(65 * 1024) + '\n')).toBe('')
    const started = Date.now()
    expect(await raw(f.service.address, '{')).toBe('')
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900)
  }, 10000)
  it('socket 和令牌为 0600，关闭后删除；长路径改用 tmpdir', async () => {
    const f = await setup()
    if (process.platform !== 'win32') {
      expect((await stat(join(f.home, 'releases/manager.token'))).mode & 0o777).toBe(0o600)
      expect((await stat(f.service.address)).mode & 0o777).toBe(0o600)
    }
    expect((await readFile(join(f.home, 'releases/manager.token'), 'utf8')).trim()).toMatch(/^[a-f0-9]{64}$/)
    await f.service.close()
    disposers.pop()
    await expect(access(join(f.home, 'releases/manager.token'))).rejects.toThrow()
    if (process.platform !== 'win32') await expect(access(f.service.address)).rejects.toThrow()
    const home = join(f.home, '长'.repeat(50))
    await mkdir(join(home, 'releases'), { recursive: true })
    const log = vi.fn()
    const service = await createControl({ home, bundled: '1.0.0', manager: f.manager, log })
    disposers.push(service.close)
    const hash = createHash('sha256').update(home).digest('hex').slice(0, 16)
    expect(controlAddress(home, 'win32')).toBe(`\\\\.\\pipe\\nextskin-${hash}`)
    if (process.platform !== 'win32') {
      expect(service.address).toBe(join(tmpdir(), `nextskin-${hash}.sock`))
      expect(log).toHaveBeenCalledWith(expect.stringContaining('临时目录'))
    }
  })
})

describe('线上状态与同步拒绝', () => {
  it('逐字段转换：步骤、方言、迁移条数、回滚和结果，完全去掉本机路径', async () => {
    const f = await setup()
    const backup = join(f.home, 'data/db.sqlite')
    await writeCurrent(f.home, {
      ...initialCurrent('1.1.0'),
      previous: '1.0.0',
      failed: ['1.2.0'],
      upgrades: { '1.1.0': { from: '1.0.0', migrations: true, dialect: 'sqlite', backup } },
    })
    f.state.current = '1.1.0'
    f.state.prepared = preflight
    f.state.operation = {
      kind: 'prepare',
      version: '1.1.0',
      step: 3,
      startedAt: '2026-10-23T00:00:00.000Z',
      progress: { received: 20, total: 100 },
    }
    f.state.lastResult = {
      at: '2026-10-22T00:00:00Z',
      kind: 'update',
      from: '1.0.0',
      to: '1.1.0',
      result: 'success',
      step: 11,
      backup,
    }
    const result = await f.call('status')
    expect(result).toEqual({
      protocol: MANAGER_PROTOCOL,
      version: '1.1.0',
      current: '1.1.0',
      previous: '1.0.0',
      writable: true,
      operation: {
        kind: 'prepare',
        version: '1.1.0',
        step: 'download',
        startedAt: '2026-10-23T00:00:00.000Z',
        progress: { received: 20, total: 100 },
      },
      prepared: {
        version: '1.1.0',
        preflight: {
          dialect: 'mysql',
          pendingCore: 1,
          pendingPlugins: 2,
          tier: 'external-backup',
          incompatiblePlugins: [{ id: 'old', api: '0' }],
        },
      },
      lastResult: {
        at: '2026-10-22T00:00:00Z',
        kind: 'update',
        from: '1.0.0',
        to: '1.1.0',
        result: 'success',
        step: 'cleanup',
        reason: null,
      },
      failed: ['1.2.0'],
      rollback: { version: '1.0.0', migrations: true, dialect: 'sqlite', backupAvailable: true },
    })
    expect(JSON.stringify(result)).not.toMatch(/private|dataDirectory|sqliteFile|"backup":/)
    for (const [step, name] of [
      'manifest',
      'space',
      'download',
      'extract',
      'preflight',
      'confirm',
      'stop',
      'migrate',
      'switch',
      'start',
      'cleanup',
    ].entries()) {
      f.state.operation.step = step + 1
      expect(((await f.call('status')) as ManagerStatus).operation?.step).toBe(name)
    }
    f.state.operation.kind = 'check'
    expect(((await f.call('status')) as ManagerStatus).operation).toBeNull()
    await rm(backup)
    expect(((await f.call('status')) as ManagerStatus).rollback?.backupAvailable).toBe(false)
  })
  it('not_prepared、backup_required、busy、readonly', async () => {
    const f = await setup()
    await expect(f.call('apply', { version: '1.1.0', backupConfirmed: false })).rejects.toMatchObject({
      code: 'not_prepared',
    })
    f.state.prepared = preflight
    await expect(f.call('apply', { version: '1.1.0', backupConfirmed: false })).rejects.toMatchObject({
      code: 'backup_required',
    })
    f.state.operation = { kind: 'check', version: '1.0.0', step: 1, startedAt: new Date().toISOString() }
    for (const [method, params] of [
      ['prepare', { version: '1.1.0' }],
      ['apply', { version: '1.1.0', backupConfirmed: true }],
      ['rollback', { confirmed: true }],
    ] as const)
      await expect(f.call(method, params)).rejects.toMatchObject({ code: 'busy' })
    const readonly = await setup(false)
    for (const [method, params] of [
      ['prepare', { version: '1.1.0' }],
      ['apply', { version: '1.1.0', backupConfirmed: true }],
      ['rollback', { confirmed: true }],
    ] as const)
      await expect(readonly.call(method, params)).rejects.toMatchObject({ code: 'readonly' })
  })
  it('no_previous、confirmation_required、backup_missing', async () => {
    const f = await setup()
    await expect(f.call('rollback', { confirmed: true })).rejects.toMatchObject({ code: 'no_previous' })
    await writeCurrent(f.home, {
      ...initialCurrent('1.1.0'),
      previous: '1.0.0',
      upgrades: { '1.1.0': { from: '1.0.0', migrations: true, dialect: 'sqlite', backup: null } },
    })
    await expect(f.call('rollback', { confirmed: false })).rejects.toMatchObject({ code: 'confirmation_required' })
    await expect(f.call('rollback', { confirmed: true })).rejects.toMatchObject({ code: 'backup_missing' })
    await writeCurrent(f.home, {
      ...initialCurrent('1.1.0'),
      previous: '1.0.0',
      upgrades: { '1.1.0': { from: '1.0.0', migrations: false, dialect: 'mysql', backup: null } },
    })
    await rm(join(f.home, 'releases/1.0.0'), { recursive: true })
    await expect(f.call('rollback', { confirmed: true })).rejects.toMatchObject({ code: 'no_previous' })
  })
})

it('prepare 立即接受，后台准备本地版本；未完成时 busy，结束后可读 prepared', async () => {
  const f = await setup()
  let finish!: (value: Preflight) => void
  vi.mocked(f.manager.prepareLocal).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  expect(await f.call('prepare', { version: '1.1.0' })).toEqual({ accepted: true })
  await vi.waitFor(() => expect(f.manager.prepareLocal).toHaveBeenCalledWith('1.1.0'))
  await expect(f.call('prepare', { version: '1.1.0' })).rejects.toMatchObject({ code: 'busy' })
  f.state.prepared = preflight
  finish(preflight)
  await vi.waitFor(async () => expect(((await f.call('status')) as ManagerStatus).operation).toBeNull())
  expect(((await f.call('status')) as ManagerStatus).prepared?.version).toBe('1.1.0')
  expect(f.manager.prepare).not.toHaveBeenCalled()
  expect(await f.call('cancel')).toEqual({ cancelled: false })
  f.state.operation = { kind: 'prepare', version: '1.1.0', step: 3, startedAt: new Date().toISOString() }
  expect(await f.call('cancel')).toEqual({ cancelled: true })
  expect(f.manager.cancel).toHaveBeenCalled()
})

it('apply 先写完 accepted 并关闭服务端 socket，再调用流水线的 stop', async () => {
  const f = await fixture()
  disposers.push(f.dispose)
  const spy = vi.spyOn(Socket.prototype, 'end')
  const supervisor = {
    start: vi.fn(async () => {}),
    stop: vi.fn(() => {
      const index = spy.mock.calls.findIndex(
        (args) => typeof args[0] === 'string' && args[0].includes('"accepted":true'),
      )
      expect(index).toBeGreaterThanOrEqual(0)
      expect((spy.mock.contexts[index] as Socket).destroyed).toBe(true)
      return Promise.resolve()
    }),
    resume: vi.fn(),
  }
  const manager = await createManager({ home: f.home, bundled: '1.0.0', supervisor })
  await manager.prepareLocal('1.1.0')
  const service = await createControl({ home: f.home, bundled: '1.0.0', manager })
  disposers.push(service.close)
  try {
    expect(
      await controlRequest(service.address, service.token, 'apply', { version: '1.1.0', backupConfirmed: false }),
    ).toEqual({ accepted: true })
    // 真实的流水线要起几次 doctor、migrate 子进程，CI 上超过 waitFor 默认的 1 秒
    await vi.waitFor(() => expect(manager.status().lastResult?.result).toBe('success'), { timeout: 10_000 })
    expect(supervisor.stop).toHaveBeenCalledTimes(1)
    expect(await managerStatus(f.home, '1.0.0', manager, true)).toMatchObject({ current: '1.1.0' })
  } finally {
    spy.mockRestore()
  }
})

it('接受后出现的前置条件竞态仍记录失败，不能把上次成功误报成本次成功', async () => {
  const f = await setup()
  vi.mocked(f.manager.prepareLocal).mockRejectedValue(new Error('unexpected'))
  expect(await f.call('prepare', { version: '1.1.0' })).toEqual({ accepted: true })
  await vi.waitFor(async () => expect(((await f.call('status')) as ManagerStatus).lastResult?.result).toBe('failed'))
  const value = (await f.call('status')) as ManagerStatus
  expect(value.lastResult).toMatchObject({ from: '1.0.0', to: '1.1.0', result: 'failed' })
  expect(await readFile(join(f.home, 'releases/update-log.jsonl'), 'utf8')).toContain('"result":"failed"')
})

it('准备由控制通道占用时 cancel 返回 true，不依赖内部 operation 的报告时机', async () => {
  const f = await setup()
  let rejectPreparation!: (error: Error) => void
  vi.mocked(f.manager.prepareLocal).mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectPreparation = reject
      }),
  )
  vi.mocked(f.manager.cancel).mockImplementation(() => rejectPreparation(new Error('cancelled')))
  await f.call('prepare', { version: '1.1.0' })
  await vi.waitFor(() => expect(f.manager.prepareLocal).toHaveBeenCalled())
  expect(await f.call('cancel')).toEqual({ cancelled: true })
  await vi.waitFor(async () => expect(((await f.call('status')) as ManagerStatus).operation).toBeNull())
})

it.skipIf(process.platform === 'win32')('权限分离的 socket 归 root:服务组且为 0660，令牌仍为 0600', async () => {
  const f = await fixture()
  disposers.push(f.dispose)
  const ownership = vi.fn<typeof chown>().mockResolvedValue(undefined)
  const manager = await createManager({ home: f.home, bundled: '1.0.0' })
  const service = await createControl({
    home: f.home,
    bundled: '1.0.0',
    manager,
    runAs: { name: 'nextskin', uid: 1234, gid: 5678 },
    chown: ownership,
  })
  disposers.push(service.close)
  expect(ownership.mock.calls).toEqual([[service.address, 0, 5678]])
  expect((await stat(service.address)).mode & 0o777).toBe(0o660)
  expect((await stat(join(f.home, 'releases/manager.token'))).mode & 0o777).toBe(0o600)
  expect(await controlRequest(service.address, service.token, 'status', {})).toMatchObject({ current: '1.0.0' })
})

it.each([
  ['/opt/nextskin/data/db.sqlite', '<路径>'],
  ['数据目录/opt/nextskin/data 无法写入，配置在“/opt/nextskin/.env”。', '数据目录<路径> 无法写入，配置在“<路径>”。'],
  [
    String.raw`数据库 C:\nextskin\data.sqlite；配置 C:/nextskin/.env，备份 \\server\share\backup.sqlite。`,
    '数据库 <路径>；配置 <路径>，备份 <路径>。',
  ],
  [
    'https://dl.nextskin.org/releases/v1.json 1.2.3 ADR-0040 --backup-confirmed --to 1.2.3 y/N',
    'https://dl.nextskin.org/releases/v1.json 1.2.3 ADR-0040 --backup-confirmed --to 1.2.3 y/N',
  ],
])('控制说明的路径清理：%s', (input, expected) => {
  expect(redactPaths(input)).toBe(expected)
})

it('线上 lastResult 和错误说明去掉路径，本地转换保留完整说明', async () => {
  const f = await setup()
  const explanation =
    '不能读取 /opt/nextskin/.env，请检查 C:/nextskin/data。参考 https://dl.nextskin.org/releases/v1.json'
  f.state.lastResult = {
    at: new Date().toISOString(),
    kind: 'manual',
    from: '1.0.0',
    to: '1.1.0',
    result: 'failed',
    step: 5,
    reason: explanation,
  }
  expect(((await f.call('status')) as ManagerStatus).lastResult?.reason).toBe(redactPaths(explanation))
  expect((await managerStatus(f.home, '1.0.0', f.manager, true, false)).lastResult?.reason).toBe(explanation)
  const status = vi.spyOn(f.manager, 'status').mockImplementationOnce(() => {
    throw new ManagerError(explanation)
  })
  await expect(f.call('status')).rejects.toThrow(redactPaths(explanation))
  status.mockRestore()
  expect(f.state.lastResult.reason).toBe(explanation)
})

it('请求在 status 期间断开，不执行操作、不永久占住预留', async () => {
  const f = await setup()
  const pause = vi.spyOn(Socket.prototype, 'pause')
  const status = vi.spyOn(f.manager, 'status').mockImplementationOnce(() => {
    const socket = pause.mock.contexts.at(-1) as Socket
    socket.destroy()
    return structuredClone(f.state)
  })
  try {
    await expect(f.call('prepare', { version: '1.1.0' })).rejects.toThrow()
    await vi.waitFor(async () => expect(((await f.call('status')) as ManagerStatus).operation).toBeNull())
    expect(f.manager.prepareLocal).not.toHaveBeenCalled()
    expect(await f.call('prepare', { version: '1.1.0' })).toEqual({ accepted: true })
  } finally {
    status.mockRestore()
    pause.mockRestore()
  }
})
