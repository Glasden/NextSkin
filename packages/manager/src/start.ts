import { constants } from 'node:fs'
import { access, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { logRunAs, resolveRunAs } from './run-as.ts'
import { createControl } from './control.ts'
import { createManager, type ManagerOptions } from './pipeline.ts'
import { waitForLock } from './lock.ts'
import { LauncherSupervisor, stopSignals } from './process.ts'
import { initialCurrent, readCurrent, requireVersion, pruneReleases, writeCurrent } from './state.ts'
import { compareVersions } from '@nextskin/updates'
import { ConfigError, ManagerError, type Manager, type Current } from './types.ts'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
/** 旧启动器不能放进 releases 运行；启动和离线升级必须共用同一个历史版本来源。 */
export async function readLegacyVersion(home: string): Promise<string | null> {
  if (await readCurrent(home)) return null
  if (!(await exists(join(home, 'server/VERSION'))) || !(await exists(join(home, 'cli')))) return null
  const version = (await readFile(join(home, 'server/VERSION'), 'utf8')).trim()
  requireVersion(version)
  return version
}
export async function removeLegacy(home: string, log: (line: string) => void = console.error): Promise<void> {
  for (const name of ['server', 'cli'])
    await rm(join(home, name), { recursive: true, force: true }).catch(() =>
      log(`[nextskin] 旧布局的 ${name} 暂时无法删除，请稍后清理`),
    )
}
export interface SelectionOptions {
  home: string
  bundled: string
  manager: Manager
  writable?: () => Promise<void>
  onReadOnly?: () => void
  writeCurrent?: typeof writeCurrent
  log?: (line: string) => void
}
/** 不做升级的命令和 off 模式只读指针，不能创建锁、探测文件或补写 bundled。 */
export async function selectedVersion(home: string, bundled: string): Promise<string> {
  requireVersion(bundled)
  return (await readCurrent(home))?.current ?? bundled
}
export async function selectVersion(options: SelectionOptions): Promise<string> {
  const { home, bundled, manager } = options
  requireVersion(bundled)
  const pointer = await readCurrent(home)
  const log = (message: string) => (options.log ?? console.error)(`[nextskin] ${message}`)
  const fallback = pointer?.current ?? bundled
  const write = async (value: Current) => {
    try {
      await (options.writeCurrent ?? writeCurrent)(home, value)
    } catch {
      throw new ReadOnlyError()
    }
  }
  try {
    try {
      await (options.writable ?? (() => access(join(home, 'releases'), constants.W_OK)))()
    } catch {
      throw new ReadOnlyError()
    }
    if (pointer) {
      if (pointer.bundled === bundled) return pointer.current
      if (compareVersions(bundled, pointer.current) <= 0) {
        log('解压的版本比当前旧，忽略；要回到旧版本用 rollback')
        await write({ ...pointer, bundled })
        return pointer.current
      }
      if (!(await exists(join(home, 'releases', bundled))))
        throw new ConfigError('解压的新版本目录不存在，请重新解压完整发行包')
      // 先落下 bundled 也验证指针是否可写；只读部署不能停站后才发现不能换指针。
      await write({ ...pointer, bundled })
      let failedSwitch: string | undefined
      try {
        try {
          const preflight = await manager.prepareLocal(bundled)
          if (preflight.tier === 'external-backup') {
            log(
              `解压的 ${bundled} 有数据库迁移，${preflight.dialect} 要先自己备份：备份以后在后台的“更新”页确认升级，或停掉服务后运行 node nextskin.mjs update --backup-confirmed；现在照旧运行 ${pointer.current}`,
            )
            return pointer.current
          }
        } catch (error) {
          if (error instanceof ConfigError) throw error
          log(error instanceof ManagerError ? error.message : '手动升级预检失败')
          return pointer.current
        }
        const result = await manager.apply(bundled)
        if (result.result !== 'success') {
          log(result.reason ?? '手动升级失败')
          if (result.result === 'failed' && result.step >= 7 && (await readCurrent(home))?.current === pointer.current)
            failedSwitch = result.reason ?? '旧版本未能恢复运行'
        }
      } finally {
        const latest = await readCurrent(home)
        if (latest) await write({ ...latest, bundled })
      }
      if (failedSwitch) throw new ManagerError(failedSwitch)
      return (await readCurrent(home))?.current ?? pointer.current
    }
    const from = await readLegacyVersion(home)
    if (from) {
      try {
        const preflight = await manager.prepareLocal(bundled, { from, legacy: true })
        if (preflight.tier === 'external-backup')
          throw new ConfigError(
            `从旧布局换过来：${preflight.dialect} 有数据库迁移，要先自己备份；备份以后在服务停着时运行 node nextskin.mjs update --backup-confirmed，再启动。不升级就照 ADR-0040 手工回退，解压旧版本的 ZIP`,
          )
        const result = await manager.apply(bundled)
        if (result.result !== 'success') throw new ManagerError(result.reason ?? '旧布局升级失败')
      } catch (error) {
        if (error instanceof ConfigError) throw error
        throw new ConfigError(
          `${error instanceof ManagerError ? error.message : '旧布局升级失败'}；请照 ADR-0040 手工回退，解压旧版本的 ZIP`,
        )
      }
      await removeLegacy(home, options.log)
      return bundled
    }
    await write(initialCurrent(bundled))
    return bundled
  } catch (error) {
    if (!(error instanceof ReadOnlyError)) throw error
    options.onReadOnly?.()
    log('releases 目录或 current.json 不可写，只读模式：不切换版本')
    return fallback
  }
}
class ReadOnlyError extends Error {}

export async function start(
  options: Omit<ManagerOptions, 'supervisor' | 'writable'> & {
    importLauncher?: (version: string) => Promise<void>
    writable?: () => Promise<void>
  },
): Promise<number> {
  const runAs = options.runAs ?? resolveRunAs(options)
  options = { ...options, runAs }
  if ((options.env ?? process.env).NEXTSKIN_MANAGER === 'off') {
    if (runAs) throw new ConfigError('NEXTSKIN_RUN_AS 需要启用管理进程，不能与 NEXTSKIN_MANAGER=off 同用')
    if (!options.importLauncher) throw new ConfigError('没有可加载的启动器')
    await options.importLauncher(await selectedVersion(options.home, options.bundled))
    return 0
  }
  logRunAs(runAs, options.log)
  const controller = new AbortController()
  const supervisor = new LauncherSupervisor(options.home, { ...options, signal: controller.signal })
  let lock: Awaited<ReturnType<typeof waitForLock>> = null
  let control: Awaited<ReturnType<typeof createControl>> | undefined
  let manager: Manager | undefined
  let shutdown: Promise<void> | undefined
  const stop = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) {
      if (signal === 'SIGINT') supervisor.force()
      return
    }
    controller.abort()
    manager?.cancel()
    shutdown = supervisor.shutdown()
  }
  for (const signal of stopSignals) process.on(signal, stop)
  try {
    // 只读部署无法创建 SQLite 锁文件；先检查可写性，避免把 EACCES 当成重复启动。
    let writable = true
    try {
      await (options.writable ?? (() => access(join(options.home, 'releases'), constants.W_OK)))()
    } catch {
      writable = false
    }
    if (writable) {
      try {
        lock = await waitForLock(join(options.home, 'releases/manager.lock'), {
          signal: controller.signal,
          log: options.log,
          now: options.now,
          sleep: options.sleep,
        })
      } catch {
        throw new ManagerError('另一个管理进程在运行，或无法取得管理进程锁')
      }
      if (!lock || controller.signal.aborted) return 0
    }
    manager = await createManager({ ...options, writable, supervisor, signal: controller.signal })
    if (writable) {
      control = await createControl({
        home: options.home,
        bundled: options.bundled,
        log: options.log,
        manager,
        runAs,
        chown: options.chown,
      })
      supervisor.setControl(control)
    }
    const version = await selectVersion({
      ...options,
      manager,
      onReadOnly: () => {
        writable = false
      },
      writable: writable ? options.writable : () => Promise.reject(new ReadOnlyError()),
    })
    if (!writable && control) {
      await control.close()
      control = undefined
      supervisor.setControl()
    }
    if (controller.signal.aborted) return 0
    if (writable) {
      const pointer = await readCurrent(options.home)
      if (pointer)
        await pruneReleases(options.home, pointer, options.log ?? console.error, [
          manager.status().prepared?.version ?? '',
        ]).catch(() => {})
    }
    // 切换已经启动了新版本或恢复了旧版本，不能再起第二个启动器。
    if (!supervisor.hasStarted) await supervisor.start(version)
    return await supervisor.finished
  } finally {
    try {
      await control?.close()
    } finally {
      try {
        if (shutdown) await shutdown
        else await supervisor.stop()
      } finally {
        lock?.release()
        for (const signal of stopSignals) process.off(signal, stop)
      }
    }
  }
}
