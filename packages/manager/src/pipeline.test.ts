import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, readFile, rm, writeFile, type chown } from 'node:fs/promises'
import { join } from 'node:path'
import { MANIFEST_URL } from '@nextskin/updates'
import { createManager } from './pipeline.ts'
import { LauncherSupervisor, runCommand } from './process.ts'
import {
  fixture,
  events,
  releaseZip,
  signedManifest,
  zipResponse,
  requestUrl,
  contains,
  healthTimeout,
} from './fixtures.ts'
import { readCurrent, writeCurrent } from './state.ts'
import { parsePreflight, parseMigration } from './preflight.ts'
import type { Dialect } from './types.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})
async function setup(dialect: Dialect = 'sqlite', pending = false, download = false) {
  const f = await fixture(['1.0.0', '1.1.0', '0.8.0'])
  disposers.push(f.dispose)
  f.behavior['1.0.0'] = { dialect }
  f.behavior['1.1.0'] = { dialect, pending }
  await f.configure()
  const log = vi.fn()
  const supervisor = new LauncherSupervisor(f.home, {
    healthTimeout,
    healthInterval: 15,
    shutdownTimeout: 100,
    log,
  })
  disposers.push(() => supervisor.shutdown())
  const zip = releaseZip('1.1.0')
  const signed = signedManifest(zip)
  const network = vi.fn<typeof fetch>((input) =>
    Promise.resolve(requestUrl(input) === MANIFEST_URL ? Response.json(signed.body) : zipResponse(zip)),
  )
  const manager = await createManager({
    home: f.home,
    bundled: '1.0.0',
    supervisor,
    log,
    keys: signed.keys,
    fetch: network,
  })
  if (download) await rm(join(f.home, 'releases/1.1.0'), { recursive: true })
  return { ...f, manager, supervisor, log, network }
}
async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('升级流水线（真实启动器子进程）', () => {
  it('签名、下载、预检、迁移、健康检查后提交指针、日志、管理进程并清理旧版本', async () => {
    const f = await setup('sqlite', true, true)
    await f.supervisor.start('1.0.0', true)
    const preflight = await f.manager.prepare('1.1.0')
    expect(preflight.tier).toBe('sqlite')
    expect(f.supervisor.running).toBe(true)
    const result = await f.manager.apply('1.1.0')
    expect(result).toMatchObject({ result: 'success', step: 11, migrations: true })
    expect(await readCurrent(f.home)).toMatchObject({
      current: '1.1.0',
      previous: '1.0.0',
      bundled: '1.1.0',
      upgrades: { '1.1.0': { from: '1.0.0', migrations: true, dialect: 'sqlite' } },
    })
    expect(await readFile(join(f.home, 'manager.next/VERSION'), 'utf8')).toBe('1.1.0')
    expect(await exists(join(f.home, 'releases/0.8.0'))).toBe(false)
    expect(await exists(join(f.home, 'releases/.staging'))).toBe(false)
    expect(JSON.parse((await readFile(join(f.home, 'releases/update-log.jsonl'), 'utf8')).trim())).toEqual(result)
    expect((await events(f.home)).filter((e) => e.command === 'start').map((e) => e.version)).toEqual([
      '1.0.0',
      '1.1.0',
    ])
    const reloaded = await createManager({ home: f.home, bundled: '1.0.0', supervisor: f.supervisor })
    expect(reloaded.status().lastResult).toEqual(result)
  })
  it.each(['fail', 'unknown', 'incomplete'] as const)('预检 %s 时不停止站点，清掉下载目标', async (failure) => {
    const f = await setup('sqlite', false, true)
    f.behavior['1.1.0'] = failure === 'fail' ? { fail: 'secret' } : { [failure]: true }
    await f.configure()
    await f.supervisor.start('1.0.0', true)
    await expect(f.manager.prepare('1.1.0')).rejects.toThrow(
      failure === 'incomplete' ? '预检结果不完整' : failure === 'unknown' ? '库比这个版本新' : '测试预检失败',
    )
    expect(f.supervisor.running).toBe(true)
    expect(await exists(join(f.home, 'releases/1.1.0'))).toBe(false)
    expect((await readCurrent(f.home))?.failed).toEqual([])
    expect((await events(f.home)).some((e) => e.command === 'shutdown')).toBe(false)
  })
  it('不兼容插件保留在预检结果里；缺字段给出固定诊断', async () => {
    const f = await setup()
    f.behavior['1.1.0'] = { incompatible: true }
    await f.configure()
    expect((await f.manager.prepareLocal('1.1.0')).incompatiblePlugins).toEqual([{ id: 'test', api: '99.0' }])
    for (const stdout of ['null', '{}', '{"results":[null]}', 'not json'])
      expect(() => parsePreflight('1.1.0', { code: 1, stdout, stderr: '' })).toThrow('预检结果不完整')
  })
  it('外部库有迁移必须先确认备份，不停原启动器', async () => {
    const f = await setup('mysql', true)
    await f.supervisor.start('1.0.0', true)
    expect((await f.manager.prepareLocal('1.1.0')).tier).toBe('external-backup')
    await expect(f.manager.apply('1.1.0')).rejects.toMatchObject({ code: 'backup_required' })
    expect(f.manager.status().lastResult).toBeNull()
    expect((await readCurrent(f.home))?.failed).toEqual([])
    expect((await events(f.home)).filter((e) => e.command === 'shutdown')).toHaveLength(0)
    expect(f.manager.status().prepared).not.toBeNull()
    expect((await f.manager.apply('1.1.0', { backupConfirmed: true })).result).toBe('success')
  })
  it.each(['sqlite', 'mysql'] as const)('%s 迁移失败时换回旧程序并照录迁移错误', async (dialect) => {
    const f = await setup(dialect, true)
    f.behavior['1.1.0']!.migrateFail = true
    f.behavior['1.1.0']!.migrateKind = 'backup'
    f.behavior['1.1.0']!.migrateMessage = '明确的迁移失败诊断'
    await f.configure()
    await f.supervisor.start('1.0.0', true)
    await f.manager.prepareLocal('1.1.0')
    const result = await f.manager.apply('1.1.0', { backupConfirmed: true })
    expect(result).toMatchObject({
      result: 'rolled-back',
      step: 8,
      error: { kind: 'backup', message: '明确的迁移失败诊断' },
    })
    expect((await readCurrent(f.home))?.current).toBe('1.0.0')
    expect((await readCurrent(f.home))?.failed).toContain('1.1.0')
    expect(await readFile(join(f.home, 'data/db.sqlite'), 'utf8')).toBe(dialect === 'sqlite' ? 'original' : 'partial')
  })
  it('MySQL 迁移失败且旧版本健康检查失败时停下，要求恢复备份', async () => {
    const f = await setup('mysql', true)
    f.behavior['1.1.0']!.migrateFail = true
    f.behavior['1.0.0']!.health = 503
    await f.configure()
    await f.manager.prepareLocal('1.1.0')
    const result = await f.manager.apply('1.1.0', { backupConfirmed: true })
    expect(result).toMatchObject({ result: 'failed', reason: contains('用升级前的备份恢复数据库') })
    expect(f.supervisor.running).toBe(false)
  })
  it('无迁移的健康检查失败会自动换回旧版', async () => {
    const f = await setup()
    f.behavior['1.1.0']!.health = 503
    await f.configure()
    await f.manager.prepareLocal('1.1.0')
    expect(await f.manager.apply('1.1.0')).toMatchObject({ result: 'rolled-back', step: 10, migrations: false })
    expect((await readCurrent(f.home))?.current).toBe('1.0.0')
    expect((await readCurrent(f.home))?.failed).toContain('1.1.0')
  })
  it('SQLite 健康检查失败会换回备份并删除 WAL/SHM', async () => {
    const f = await setup('sqlite', true)
    f.behavior['1.1.0']!.health = 503
    await f.configure()
    await writeFile(join(f.home, 'data/db.sqlite-wal'), 'wal')
    await writeFile(join(f.home, 'data/db.sqlite-shm'), 'shm')
    await f.manager.prepareLocal('1.1.0')
    expect((await f.manager.apply('1.1.0')).result).toBe('rolled-back')
    expect(await readFile(join(f.home, 'data/db.sqlite'), 'utf8')).toBe('original')
    expect(await exists(join(f.home, 'data/db.sqlite-wal'))).toBe(false)
    expect(await exists(join(f.home, 'data/db.sqlite-shm'))).toBe(false)
  })
  it.each(['postgres', 'mysql'] as const)('%s 有迁移而健康检查失败，保留新程序', async (dialect) => {
    const f = await setup(dialect, true)
    f.behavior['1.1.0']!.health = 503
    await f.configure()
    await f.manager.prepareLocal('1.1.0')
    expect(await f.manager.apply('1.1.0', { backupConfirmed: true })).toMatchObject({
      result: 'failed',
      reason: contains('新版本保留运行'),
    })
    expect((await readCurrent(f.home))?.current).toBe('1.1.0')
    expect((await readCurrent(f.home))?.failed).toContain('1.1.0')
    expect(f.supervisor.running).toBe(true)
  })
  it('新版本以 78 退出算切换失败', async () => {
    const f = await setup()
    f.behavior['1.1.0']!.exit = 78
    await f.configure()
    await f.manager.prepareLocal('1.1.0')
    expect(await f.manager.apply('1.1.0')).toMatchObject({ result: 'rolled-back', reason: contains('78') })
  })
  it('数据锁等待失败时恢复原版本', async () => {
    const f = await setup()
    const manager = await createManager({
      home: f.home,
      bundled: '1.0.0',
      supervisor: f.supervisor,
      lock: () => Promise.reject(new Error('busy')),
    })
    await manager.prepareLocal('1.1.0')
    expect(await manager.apply('1.1.0')).toMatchObject({ result: 'rolled-back', step: 7 })
    expect((await events(f.home)).some((e) => e.command === 'migrate')).toBe(false)
    expect((await readCurrent(f.home))?.failed).toEqual([])
  })
})

describe('回滚', () => {
  it.each(['sqlite', 'mysql', 'postgres'] as const)('%s 迁移后的确认和数据库恢复规则', async (dialect) => {
    const f = await setup(dialect, true)
    await f.manager.prepareLocal('1.1.0')
    expect((await f.manager.apply('1.1.0', { backupConfirmed: true })).result).toBe('success')
    await expect(f.manager.rollback()).rejects.toMatchObject({
      code: 'confirmation_required',
      message: contains(dialect === 'sqlite' ? '写入都会丢失' : '恢复数据库'),
    })
    if (dialect !== 'sqlite') await writeFile(join(f.home, 'data/db.sqlite'), 'original')
    const result = await f.manager.rollback({ confirmed: true })
    expect(result).toMatchObject({ kind: 'rollback', result: 'success' })
    expect(await readCurrent(f.home)).toMatchObject({ current: '1.0.0', previous: null })
    expect(await readFile(join(f.home, 'data/db.sqlite'), 'utf8')).toBe('original')
    await expect(f.manager.rollback({ confirmed: true })).rejects.toThrow('没有可回滚')
  })
  it('无迁移直接回滚，健康检查失败时重新回到当前版本', async () => {
    const f = await setup()
    await f.manager.prepareLocal('1.1.0')
    await f.manager.apply('1.1.0')
    f.behavior['1.0.0']!.health = 503
    await f.configure()
    expect((await f.manager.rollback()).result).toBe('rolled-back')
    expect((await readCurrent(f.home))?.current).toBe('1.1.0')
    f.behavior['1.0.0']!.health = 200
    await f.configure()
    expect((await f.manager.rollback()).result).toBe('success')
  })
  it('备份或 previous 目录不在时拒绝', async () => {
    const f = await setup('sqlite', true)
    await f.manager.prepareLocal('1.1.0')
    await f.manager.apply('1.1.0')
    await rm(join(f.home, 'data/backup-1.1.0.sqlite'))
    await expect(f.manager.rollback({ confirmed: true })).rejects.toMatchObject({ code: 'backup_missing' })
    await rm(join(f.home, 'releases/1.0.0'), { recursive: true })
    await expect(f.manager.rollback({ confirmed: true })).rejects.toMatchObject({ code: 'no_previous' })
  })
})

describe('准备的边界和互斥', () => {
  it.each([{ managerProtocol: 99 }, { minNode: 999 }])('协议或 Node 不兼容：%j', async (overrides) => {
    const f = await setup()
    const zip = releaseZip('1.1.0')
    const signed = signedManifest(zip, '1.1.0', overrides)
    const manager = await createManager({
      home: f.home,
      bundled: '1.0.0',
      keys: signed.keys,
      fetch: vi.fn(() => Promise.resolve(Response.json(signed.body))),
    })
    await expect(manager.prepare('1.1.0')).rejects.toThrow(overrides.minNode ? 'Node 999' : '覆盖解压它的 ZIP')
  })
  it('拒绝路径、旧版本、未签名目标，磁盘不足', async () => {
    const f = await setup()
    for (const version of ['../outside', 'https://example.test'])
      await expect(f.manager.prepare(version)).rejects.toThrow('版本号')
    await expect(f.manager.prepare('2.0.0')).rejects.toThrow('签名有效')
    const zip = releaseZip('1.0.0')
    const signed = signedManifest(zip, '1.0.0')
    const old = await createManager({
      home: f.home,
      bundled: '1.0.0',
      keys: signed.keys,
      fetch: vi.fn(() => Promise.resolve(Response.json(signed.body))),
    })
    await expect(old.prepare('1.0.0')).rejects.toThrow('必须比当前版本新')
    const next = signedManifest(releaseZip('1.1.0'))
    const full = await createManager({
      home: f.home,
      bundled: '1.0.0',
      keys: next.keys,
      fetch: vi.fn(() => Promise.resolve(Response.json(next.body))),
      space: () => Promise.resolve(0),
    })
    await expect(full.prepare('1.1.0')).rejects.toThrow('剩余空间不足')
  })
  it('check 隐藏失败版本，更新条目出现后可再选；无效签名不返回', async () => {
    const f = await setup()
    const pointer = (await readCurrent(f.home))!
    await writeCurrent(f.home, { ...pointer, failed: ['1.1.0'] })
    const zip = releaseZip('1.1.0')
    const signed = signedManifest(zip)
    const network = vi.fn(() => Promise.resolve(Response.json(signed.body)))
    const manager = await createManager({ home: f.home, bundled: '1.0.0', keys: signed.keys, fetch: network })
    expect(await manager.check()).toEqual([])
    const newer = signedManifest(releaseZip('1.2.0'), '1.2.0')
    const another = await createManager({
      home: f.home,
      bundled: '1.0.0',
      keys: { ...signed.keys, new: newer.keys.test },
      fetch: vi.fn(() =>
        Promise.resolve(
          Response.json({ schema: 1, releases: [signed.body.releases[0], { ...newer.body.releases[0], key: 'new' }] }),
        ),
      ),
    })
    // key 不在签名内容里，公钥仍要匹配。
    expect((await another.check()).map((e) => e.version)).toEqual(['1.2.0', '1.1.0'])
    signed.body.releases[0]!.signature = 'invalid'
    expect(await manager.check()).toEqual([])
  })
  it('status 在准备中可读，取消会清理；第二个操作不会穿过互斥', async () => {
    const f = await setup('sqlite', false, true)
    let entered!: () => void
    const waiting = new Promise<void>((r) => {
      entered = r
    })
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      if (requestUrl(input) === MANIFEST_URL) return f.network(input, init)
      entered()
      return new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('cancel')), { once: true }),
      )
    })
    const zip = releaseZip('1.1.0')
    const signed = signedManifest(zip)
    const manager = await createManager({
      home: f.home,
      bundled: '1.0.0',
      keys: signed.keys,
      fetch: (input, init) =>
        requestUrl(input) === MANIFEST_URL ? Promise.resolve(Response.json(signed.body)) : fetcher(input, init),
    })
    const preparing = manager.prepare('1.1.0')
    const rejected = expect(preparing).rejects.toThrow('取消')
    await waiting
    expect(manager.status().operation).toMatchObject({ kind: 'prepare', step: 3 })
    await expect(manager.prepareLocal('1.1.0')).rejects.toThrow('已有管理操作')
    await expect(manager.apply('1.1.0')).rejects.toThrow('已有管理操作')
    await expect(manager.check()).rejects.toThrow('已有管理操作')
    manager.cancel()
    await rejected
    expect(manager.status().operation).toBeNull()
    expect(await exists(join(f.home, 'releases/1.1.0'))).toBe(false)
  })
  it('SQLite 指针切换失败后恢复库，健康检查通过后记录失败不回退程序', async () => {
    const f = await setup('sqlite', true)
    let fail = true
    const manager = await createManager({
      home: f.home,
      bundled: '1.0.0',
      supervisor: f.supervisor,
      writeCurrent: async (home, pointer) => {
        if (pointer.current === '1.1.0' && fail) {
          fail = false
          throw new Error('write failed')
        }
        await writeCurrent(home, pointer)
      },
    })
    await manager.prepareLocal('1.1.0')
    expect((await manager.apply('1.1.0')).result).toBe('rolled-back')
    expect(await readFile(join(f.home, 'data/db.sqlite'), 'utf8')).toBe('original')
  })
  it('command 超时会结束真实子进程', async () => {
    const f = await setup()
    f.behavior['1.1.0']!.doctorDelay = 2000
    await f.configure()
    await expect(runCommand(f.home, '1.1.0', 'doctor', { timeout: 30 })).rejects.toThrow('超时')
  })
})

it('只有官方插件迁移也属于 SQLite 备份档，不能当作无迁移升级', async () => {
  const f = await setup()
  f.behavior['1.1.0'] = { pluginPending: true }
  await f.configure()
  const preflight = await f.manager.prepareLocal('1.1.0')
  expect(preflight).toMatchObject({
    tier: 'sqlite',
    pendingCore: [],
    pendingPlugins: [{ plugin: 'official', migrations: ['plugin-1'] }],
  })
  expect(await f.manager.apply('1.1.0')).toMatchObject({ result: 'success', migrations: true })
  expect((await readCurrent(f.home))?.upgrades['1.1.0']?.backup).toBe(join(f.home, 'data/backup-1.1.0.sqlite'))
})

it('外部库已迁移而第一次写指针失败时，仍启动新程序', async () => {
  const f = await setup('postgres', true)
  await f.supervisor.start('1.0.0', true)
  let fail = true
  const manager = await createManager({
    home: f.home,
    bundled: '1.0.0',
    supervisor: f.supervisor,
    writeCurrent: async (home, pointer) => {
      if (pointer.current === '1.1.0' && fail) {
        fail = false
        throw new Error('busy')
      }
      await writeCurrent(home, pointer)
    },
  })
  await manager.prepareLocal('1.1.0')
  expect(await manager.apply('1.1.0', { backupConfirmed: true })).toMatchObject({
    result: 'failed',
    reason: contains('新版本保留运行'),
  })
  const deadline = Date.now() + 2000
  while (!(await events(f.home)).some((e) => e.command === 'start' && e.version === '1.1.0')) {
    if (Date.now() > deadline) throw new Error('新程序没有启动')
    await new Promise((r) => setTimeout(r, 5))
  }
  expect((await readCurrent(f.home))?.current).toBe('1.1.0')
})

it('迁移退出 0 却缺少报告且 SQLite 已改变、没有还原点时保留新程序', async () => {
  const f = await setup('sqlite', true)
  const manager = await createManager({
    home: f.home,
    bundled: '1.0.0',
    supervisor: f.supervisor,
    command: async (version, command, timeout) => {
      const result = await runCommand(f.home, version, command, { timeout })
      return command === 'migrate' ? { ...result, stdout: '{}' } : result
    },
  })
  await manager.prepareLocal('1.1.0')
  expect(await manager.apply('1.1.0')).toMatchObject({
    result: 'failed',
    migrations: true,
    reason: contains('数据库已经部分迁移'),
  })
  expect((await readCurrent(f.home))?.current).toBe('1.1.0')
  expect((await events(f.home)).some((e) => e.command === 'start' && e.version === '1.0.0')).toBe(false)
})

it('archive 下载持续更新 operation.progress，离开下载步骤后清除', async () => {
  const f = await setup()
  const zip = releaseZip('1.1.0')
  const signed = signedManifest(zip)
  const progress: unknown[] = []
  const manager = await createManager({
    home: f.home,
    bundled: '1.0.0',
    keys: signed.keys,
    fetch: (input) =>
      Promise.resolve(requestUrl(input) === MANIFEST_URL ? Response.json(signed.body) : zipResponse(zip)),
    onProgress() {
      progress.push(manager.status().operation)
    },
  })
  await manager.prepare('1.1.0')
  expect(progress[0]).toMatchObject({ kind: 'prepare', step: 3, progress: { received: 0, total: zip.length } })
  expect(progress.at(-1)).toMatchObject({
    kind: 'prepare',
    step: 3,
    progress: { received: zip.length, total: zip.length },
  })
  expect(manager.status().operation).toBeNull()
})

it.each([
  [{ managerProtocol: 99 }, 'manager_outdated'],
  [{ minNode: 999 }, 'node_too_old'],
] as const)('prepare 保留结构化错误码：%j', async (overrides, code) => {
  const f = await setup()
  const signed = signedManifest(releaseZip('1.1.0'), '1.1.0', overrides)
  const manager = await createManager({
    home: f.home,
    bundled: '1.0.0',
    keys: signed.keys,
    fetch: () => Promise.resolve(Response.json(signed.body)),
  })
  await expect(manager.prepare('1.1.0')).rejects.toMatchObject({ code })
  expect((await readCurrent(f.home))?.failed).toEqual([])
  expect((await manager.check()).map((entry) => entry.version)).toContain('1.1.0')
})

it('格式、清单、版本顺序、预检、下载错误都有对应 code', async () => {
  const f = await setup()
  await expect(f.manager.prepare('../bad')).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(f.manager.prepare('8.0.0')).rejects.toMatchObject({ code: 'unknown_version' })
  await expect(f.manager.prepareLocal('0.8.0')).rejects.toMatchObject({ code: 'not_newer' })
  f.behavior['1.1.0'] = { unknown: true }
  await f.configure()
  await expect(f.manager.prepareLocal('1.1.0')).rejects.toMatchObject({ code: 'preflight_failed' })
  const signed = signedManifest(releaseZip('1.1.0'))
  const manager = await createManager({
    home: f.home,
    bundled: '1.0.0',
    keys: signed.keys,
    fetch: (input) =>
      Promise.resolve(requestUrl(input) === MANIFEST_URL ? Response.json(signed.body) : new Response('bad')),
  })
  await expect(manager.prepare('1.1.0')).rejects.toMatchObject({ code: 'download_failed' })
  expect((await readCurrent(f.home))?.failed).toEqual([])
  expect((await manager.check()).map((entry) => entry.version)).toContain('1.1.0')
})

it.skipIf(process.platform === 'win32').each([false, true])(
  'SQLite 回滚改名前归服务用户并保留库权限（库不存在=%s）',
  async (missing) => {
    const f = await setup('sqlite', true)
    const { chmod, stat } = await import('node:fs/promises')
    const database = join(f.home, 'data/db.sqlite')
    const ownership = vi.fn<typeof chown>().mockImplementation(async (file) => {
      // restore 文件仍未改名，此时旧库或缺失状态必须保持原样。
      if (String(file).endsWith('.restore')) {
        if (missing) expect(await exists(database)).toBe(false)
        else expect(await readFile(database, 'utf8')).toBe('db:1.1.0')
      }
    })
    let removeBeforeRestore = false
    const supervisor = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {
        if (removeBeforeRestore) await rm(database)
      }),
      resume: vi.fn(),
    }
    const manager = await createManager({
      home: f.home,
      bundled: '1.0.0',
      supervisor,
      command: (version, name, timeout, signal) => runCommand(f.home, version, name, { timeout, signal }),
      runAs: { name: 'nextskin', uid: 1234, gid: 5678 },
      chown: ownership,
    })
    await manager.prepareLocal('1.1.0')
    expect((await manager.apply('1.1.0')).result).toBe('success')
    await chmod(database, 0o640)
    removeBeforeRestore = missing
    expect((await manager.rollback({ confirmed: true })).result).toBe('success')
    const restores = ownership.mock.calls.filter((call) => String(call[0]).endsWith('.restore'))
    expect(restores).toHaveLength(1)
    expect(restores[0]?.slice(1)).toEqual([1234, 5678])
    expect((await stat(database)).mode & 0o777).toBe(missing ? 0o600 : 0o640)
    expect(await readFile(database, 'utf8')).toBe('original')
    expect(ownership.mock.calls.some((call) => String(call[0]) === join(f.home, 'data/nextskin.lock'))).toBe(true)
  },
)

it('root 未设 RUN_AS 时 prepare 的配置错误不变成普通失败或标记版本失败', async () => {
  const f = await setup()
  const { stat } = await import('node:fs/promises')
  const info = await stat(join(f.home, 'data'))
  info.uid = 1234
  const manager = await createManager({
    home: f.home,
    bundled: '1.0.0',
    getuid: () => 0,
    stat: vi.fn(() => Promise.resolve(info)),
    checkDataOwner: true,
  })
  await expect(manager.prepareLocal('1.1.0')).rejects.toMatchObject({ exitCode: 78 })
  expect(manager.status().lastResult).toBeNull()
  expect(manager.status().operation).toBeNull()
  expect((await readCurrent(f.home))?.failed).toEqual([])
  expect((await events(f.home)).some((event) => ['migrate', 'start'].includes(event.command))).toBe(false)
})

it('常驻的管理进程不查数据归属：迁移和服务是同一个用户', async () => {
  const f = await setup()
  const { stat } = await import('node:fs/promises')
  const info = await stat(join(f.home, 'data'))
  info.uid = 1234
  const inspect = vi.fn(() => Promise.resolve(info))
  const manager = await createManager({ home: f.home, bundled: '1.0.0', getuid: () => 0, stat: inspect })
  await manager.prepareLocal('1.1.0')
  expect(manager.status().prepared?.version).toBe('1.1.0')
  expect(inspect).not.toHaveBeenCalled()
})

it('apply 和 rollback 同样保留数据归属配置错误的退出码 78', async () => {
  const f = await setup()
  const { stat } = await import('node:fs/promises')
  const info = await stat(join(f.home, 'data'))
  info.uid = 0
  const inspect = vi.fn(() => Promise.resolve(info))
  const manager = await createManager({
    home: f.home,
    bundled: '1.0.0',
    getuid: () => 0,
    stat: inspect,
    checkDataOwner: true,
  })
  await manager.prepareLocal('1.1.0')
  info.uid = 1234
  await expect(manager.apply('1.1.0')).rejects.toMatchObject({ exitCode: 78 })
  expect(manager.status().prepared?.version).toBe('1.1.0')
  await writeCurrent(f.home, {
    ...(await readCurrent(f.home))!,
    current: '1.1.0',
    previous: '1.0.0',
    upgrades: { '1.1.0': { from: '1.0.0', migrations: false, dialect: 'sqlite', backup: null } },
  })
  await expect(manager.rollback({ confirmed: true })).rejects.toMatchObject({ exitCode: 78 })
  expect(manager.status().operation).toBeNull()
  expect((await events(f.home)).some((event) => ['migrate', 'start'].includes(event.command))).toBe(false)
})

describe('部分迁移的失败恢复', () => {
  it('SQLite 核心提交、插件失败后恢复报告里的备份，再启动旧版', async () => {
    const f = await setup('sqlite', true)
    f.behavior['1.1.0'] = { pending: true, pluginPending: true, migrateFail: true, migratePartial: true }
    await f.configure()
    await f.supervisor.start('1.0.0', true)
    await f.manager.prepareLocal('1.1.0')
    const result = await f.manager.apply('1.1.0')
    expect(result).toMatchObject({
      result: 'rolled-back',
      migrations: true,
      backup: join(f.home, 'data/backup-1.1.0.sqlite'),
    })
    expect(await readFile(join(f.home, 'data/db.sqlite'), 'utf8')).toBe('original')
    expect((await readCurrent(f.home))?.current).toBe('1.0.0')
    expect(f.supervisor.running).toBe(true)
    expect((await events(f.home)).filter((e) => e.command === 'start').map((e) => e.version)).toEqual([
      '1.0.0',
      '1.0.0',
    ])
    expect(JSON.parse((await readFile(join(f.home, 'releases/update-log.jsonl'), 'utf8')).trim())).toEqual(result)
  })
  it.each(['postgres', 'mysql', 'mariadb'] as const)('%s 核心提交、插件失败后保留新指针和新程序', async (dialect) => {
    const f = await setup(dialect, true)
    f.behavior['1.1.0'] = { dialect, pending: true, pluginPending: true, migrateFail: true, migratePartial: true }
    await f.configure()
    await f.manager.prepareLocal('1.1.0')
    expect(await f.manager.apply('1.1.0', { backupConfirmed: true })).toMatchObject({
      result: 'failed',
      migrations: true,
      backup: null,
      reason: contains('数据库已经部分迁移，新版本保留，需要管理员用升级前的备份恢复'),
    })
    expect((await readCurrent(f.home))?.current).toBe('1.1.0')
    // 启动记录由真实的启动器子进程写，CI 上可能超过 waitFor 默认的 1 秒
    await vi.waitFor(
      async () => expect((await events(f.home)).some((e) => e.command === 'start' && e.version === '1.1.0')).toBe(true),
      { timeout: 10_000 },
    )
    expect((await events(f.home)).some((e) => e.command === 'start' && e.version === '1.0.0')).toBe(false)
  })
  it('报告没有已提交迁移时，在数据锁内用 doctor 的待执行项判断变化', async () => {
    const f = await setup('postgres', true)
    f.behavior['1.1.0'] = {
      dialect: 'postgres',
      pending: true,
      pluginPending: true,
      migrateFail: true,
      migratePartial: true,
      omitMigrationReport: true,
    }
    await f.configure()
    const { acquireLock } = await import('./lock.ts')
    let migrated = false
    let checked = false
    const manager = await createManager({
      home: f.home,
      bundled: '1.0.0',
      supervisor: f.supervisor,
      command: async (version, name, timeout, signal) => {
        if (name === 'doctor' && migrated) {
          const lock = await acquireLock(join(f.home, 'data/nextskin.lock'))
          lock?.release()
          expect(lock).toBeNull()
          checked = true
        }
        const report = await runCommand(f.home, version, name, { timeout, signal })
        if (name === 'migrate') migrated = true
        return report
      },
    })
    await manager.prepareLocal('1.1.0')
    expect(await manager.apply('1.1.0', { backupConfirmed: true })).toMatchObject({
      result: 'failed',
      migrations: true,
    })
    expect(checked).toBe(true)
    expect((await readCurrent(f.home))?.current).toBe('1.1.0')
    expect((await events(f.home)).some((e) => e.command === 'start' && e.version === '1.0.0')).toBe(false)
  })
  it('迁移崩溃没有报告且 doctor 显示未变，恢复旧程序', async () => {
    const f = await setup('postgres', true)
    f.behavior['1.1.0'] = { dialect: 'postgres', pending: true, migrateCrash: true }
    await f.configure()
    await f.manager.prepareLocal('1.1.0')
    expect(await f.manager.apply('1.1.0', { backupConfirmed: true })).toMatchObject({
      result: 'rolled-back',
      migrations: false,
      backup: null,
    })
    expect((await readCurrent(f.home))?.current).toBe('1.0.0')
    expect(f.supervisor.running).toBe(true)
  })
  it('doctor 也失败时恢复旧程序并明确状态不确定，日志保守标记 migrations', async () => {
    const f = await setup('postgres', true)
    f.behavior['1.1.0'] = { dialect: 'postgres', pending: true, migrateFail: true, doctorFailAfterMigration: true }
    await f.configure()
    await f.manager.prepareLocal('1.1.0')
    expect(await f.manager.apply('1.1.0', { backupConfirmed: true })).toMatchObject({
      result: 'rolled-back',
      migrations: true,
      reason: contains('无法确认数据库是否已经部分迁移'),
    })
  })
})

it('停站拿锁后外部库出现新迁移而没有确认备份，不执行 migrate', async () => {
  const f = await setup('postgres')
  let doctors = 0
  const manager = await createManager({
    home: f.home,
    bundled: '1.0.0',
    supervisor: f.supervisor,
    command: async (version, name, timeout, signal) => {
      if (name === 'doctor' && ++doctors === 3) {
        f.behavior['1.1.0'] = { dialect: 'postgres', pending: true }
        await f.configure()
      }
      return runCommand(f.home, version, name, { timeout, signal })
    },
  })
  await manager.prepareLocal('1.1.0')
  expect(await manager.apply('1.1.0')).toMatchObject({
    result: 'rolled-back',
    reason: contains('停站期间有了新的数据库迁移，先备份，再重新准备并确认'),
  })
  expect((await readCurrent(f.home))?.failed).toEqual([])
  expect(doctors).toBe(3)
  expect((await events(f.home)).some((e) => e.command === 'migrate')).toBe(false)
  expect((await readCurrent(f.home))?.current).toBe('1.0.0')
  expect(f.supervisor.running).toBe(true)
})

it('失败报告校验已提交列表；缺失或损坏的列表按空处理', () => {
  for (const fields of [
    { core: ['001'], plugins: [{ plugin: 'p', migrations: ['001'] }] },
    { core: 1, plugins: [{ plugin: 'p', migrations: 1 }] },
    {},
  ]) {
    let caught: unknown
    try {
      parseMigration({
        code: 1,
        stdout: JSON.stringify({ error: { kind: 'migration', message: '失败' }, ...fields }),
        stderr: '',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      core: Array.isArray(fields.core) ? fields.core : [],
      plugins: Array.isArray(fields.core) ? fields.plugins : [],
      backup: null,
    })
  }
})

it('协议不兼容时优先提示重启待生效的管理进程，否则选择最新兼容中间版本', async () => {
  const f = await setup()
  const target = signedManifest(releaseZip('2.0.0'), '2.0.0', { managerProtocol: 2 })
  const middle = signedManifest(releaseZip('1.2.0'), '1.2.0')
  const older = signedManifest(releaseZip('1.1.0'), '1.1.0')
  const manager = await createManager({
    home: f.home,
    bundled: '1.0.0',
    keys: { ...target.keys, middle: middle.keys.test, older: older.keys.test },
    fetch: () =>
      Promise.resolve(
        Response.json({
          schema: 1,
          releases: [
            target.body.releases[0],
            { ...older.body.releases[0], key: 'older' },
            { ...middle.body.releases[0], key: 'middle' },
          ],
        }),
      ),
  })
  const intermediate = '2.0.0 要求更新的管理进程：先升级到 1.2.0，重启一次服务，再升级到 2.0.0'
  await expect(manager.prepare('2.0.0')).rejects.toMatchObject({ code: 'manager_outdated', message: intermediate })
  await mkdir(join(f.home, 'manager.next'))
  for (const version of ['invalid', '1.0.0', '0.9.0']) {
    await writeFile(join(f.home, 'manager.next/VERSION'), version)
    await expect(manager.prepare('2.0.0')).rejects.toThrow(intermediate)
  }
  await writeFile(join(f.home, 'manager.next/VERSION'), '1.2.0\n')
  await expect(manager.prepare('2.0.0')).rejects.toMatchObject({
    code: 'manager_outdated',
    message: '先重启一次服务，让新的管理进程生效，再升级到 2.0.0',
  })
  expect((await readCurrent(f.home))?.failed).toEqual([])
})
