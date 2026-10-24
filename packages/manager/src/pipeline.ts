import { access, chmod, chown, copyFile, rm, stat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MANAGER_PROTOCOL,
  MANIFEST_URL,
  RELEASE_KEYS,
  compareVersions,
  newerReleases,
  readManifest,
  type ReleaseEntry,
} from '@nextskin/updates'
import { download, extract, verifyRelease, type DownloadOptions } from './archive.ts'
import { waitForLock, type Lock } from './lock.ts'
import { assertDataOwner } from './run-as.ts'
import { MigrationError, parseMigration, parsePreflight } from './preflight.ts'
import { LauncherSupervisor, runCommand, type Runtime, type CommandResult } from './process.ts'
import {
  appendLog,
  initialCurrent,
  lastLog,
  readCurrent,
  pendingManager,
  renameRetry,
  requireVersion,
  validVersion,
  pruneReleases,
  writeCurrent,
} from './state.ts'
import {
  ConfigError,
  ManagerError,
  reason,
  type Current,
  type Manager,
  type InternalManagerStatus,
  type MigrationResult,
  type Preflight,
  type UpdateLog,
  type UpgradeResult,
} from './types.ts'

export interface ManagerOptions extends Runtime, DownloadOptions {
  home: string
  bundled: string
  writable?: boolean
  keys?: Readonly<Record<string, string>>
  nodeMajor?: number
  supervisor?: Pick<LauncherSupervisor, 'start' | 'stop' | 'resume'>
  command?: (version: string, command: string, timeout: number, signal?: AbortSignal) => Promise<CommandResult>
  lock?: (file: string, signal?: AbortSignal) => Promise<Lock | null>
  space?: (directory: string) => Promise<number>
  doctorTimeout?: number
  migrateTimeout?: number
  /** 等数据锁的期限，默认 40 秒（等启动器退出）。服务停着时命令行用短的：拿不到说明服务还在跑，等也没用 */
  lockTimeout?: number
  writeCurrent?: typeof writeCurrent
  /**
   * 命令行在服务停着时自己执行流水线，运行它的用户不一定是服务的用户：root 没设 NEXTSKIN_RUN_AS 而数据目录属于别人时拒绝。
   * 管理进程常驻时不查，那时迁移和服务本来就是同一个用户
   */
  checkDataOwner?: boolean
}
interface Prepared {
  preflight: Preflight
  from: string
  kind: UpdateLog['kind']
  owned: boolean
}

export async function createManager(options: ManagerOptions): Promise<Manager> {
  const { home } = options
  requireVersion(options.bundled)
  let pointer = await readCurrent(home)
  let lastResult = await lastLog(home)
  let operation: InternalManagerStatus['operation'] = null
  let prepared: Prepared | null = null
  let cancellation: AbortController | null = null
  const supervisor = options.supervisor ?? new LauncherSupervisor(home, options)
  const log = (message: string) => (options.log ?? console.error)(`[nextskin] ${message}`)
  const current = () => pointer?.current ?? options.bundled
  const staging = join(home, 'releases/.staging')
  const command = (version: string, name: string, timeout: number, signal?: AbortSignal) =>
    options.command
      ? options.command(version, name, timeout, signal)
      : runCommand(home, version, name, { ...options, signal, timeout })
  const save = async (next: Current) => {
    await (options.writeCurrent ?? writeCurrent)(home, next)
    pointer = structuredClone(next)
  }
  const record = async (entry: UpdateLog) => {
    lastResult = entry
    await appendLog(home, entry)
  }
  const step = (value: number) => {
    if (operation) {
      operation.step = value
      delete operation.progress
    }
  }
  const timestamp = () => new Date((options.now ?? Date.now)()).toISOString()
  const lock = (preflight: Preflight) =>
    options.lock
      ? options.lock(join(preflight.dataDirectory, 'nextskin.lock'), options.signal)
      : waitForLock(join(preflight.dataDirectory, 'nextskin.lock'), {
          timeout: options.lockTimeout,
          signal: options.signal,
          log: options.log,
          now: options.now,
          sleep: options.sleep,
          runAs: options.runAs,
          chown: options.chown,
        })
  const doctor = async (version: string, signal?: AbortSignal) => {
    try {
      const preflight = parsePreflight(
        version,
        await command(version, 'doctor', options.doctorTimeout ?? 120_000, signal),
      )
      if (options.checkDataOwner) await assertDataOwner(preflight.dataDirectory, options)
      return preflight
    } catch (error) {
      if (error instanceof ConfigError) throw error
      throw new ManagerError(reason(error), 'preflight_failed')
    }
  }
  const cleanPreparation = async (version: string, owned: boolean) => {
    for (const path of [
      join(staging, `${version}.zip`),
      join(staging, version),
      join(staging, `manager-${version}`),
      ...(owned ? [join(home, 'releases', version)] : []),
    ])
      await rm(path, { recursive: true, force: true }).catch(() => {})
  }
  const markFailed = async (version: string) => {
    // 旧布局没有可启动的旧指针，失败时保持无指针，留给人工恢复旧 ZIP。
    if (pointer && !pointer.failed.includes(version)) await save({ ...pointer, failed: [...pointer.failed, version] })
  }
  const begin = (kind: NonNullable<InternalManagerStatus['operation']>['kind'], version: string) => {
    if (!validVersion(version)) throw new ManagerError('版本号必须符合 semver，不能是路径或地址', 'invalid_request')
    if (operation) throw new ManagerError('已有管理操作正在进行', 'busy')
    if (kind !== 'check' && options.writable === false) throw new ManagerError('实例目录不可写', 'readonly')
    if (options.signal?.aborted) throw new ManagerError('管理进程正在停止')
    operation = { kind, version, step: kind === 'prepare' || kind === 'check' ? 1 : 6, startedAt: timestamp() }
  }
  const manifest = async (signal?: AbortSignal): Promise<ReleaseEntry[]> => {
    try {
      const response = await (options.fetch ?? fetch)(MANIFEST_URL, {
        signal: AbortSignal.any([
          AbortSignal.timeout(options.connectionTimeout ?? 30_000),
          ...(signal ? [signal] : []),
        ]),
        redirect: 'follow',
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new ManagerError('无法取得版本清单', 'download_failed')
      }
      // 清单不是发行包；单独限制体积，避免响应无限增长。
      if (!response.body) throw new ManagerError('版本清单为空', 'download_failed')
      const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.length
          if (size > 4 * 1024 * 1024) throw new ManagerError('版本清单过大', 'download_failed')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      return readManifest(Buffer.concat(chunks).toString('utf8'), options.keys ?? RELEASE_KEYS).releases
    } catch (error) {
      if (signal?.aborted) throw new ManagerError('操作已取消')
      if (error instanceof ManagerError) throw error
      throw new ManagerError('版本清单无法读取或签名校验失败', 'download_failed')
    }
  }
  const freeSpace = async (directory: string) => {
    if (options.space) return options.space(directory)
    const space = await statfs(directory)
    return space.bavail * space.bsize
  }
  const checkSpace = async (zipSize: number, inspected?: Preflight) => {
    let databaseSize = 0
    if (inspected?.dialect === 'sqlite' && inspected.sqliteFile) {
      try {
        databaseSize = (await stat(inspected.sqliteFile)).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // 数据和程序可能在不同文件系统上，两边都要有备份所需的空间。
      let directory = dirname(inspected.sqliteFile)
      for (;;) {
        try {
          if ((await freeSpace(directory)) < databaseSize)
            throw new ManagerError('数据库所在磁盘剩余空间不足，无法备份 SQLite', 'preflight_failed')
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || directory === dirname(directory)) throw error
          directory = dirname(directory)
        }
      }
    }
    if ((await freeSpace(join(home, 'releases'))) < zipSize * 4 + databaseSize)
      throw new ManagerError('剩余空间不足，无法下载、解压和备份', 'preflight_failed')
  }
  const prepare = async (version: string, local?: { from?: string; legacy?: boolean }): Promise<Preflight> => {
    begin('prepare', version)
    const from = local?.from ?? current()
    const kind = local ? (local.legacy ? 'legacy' : 'manual') : 'update'
    let owned = false
    cancellation = new AbortController()
    const signal = AbortSignal.any([cancellation.signal, ...(options.signal ? [options.signal] : [])])
    try {
      requireVersion(from)
      // 前一次准备的目录只有当前对象会使用；重新准备时释放它，防止取消后留下半成品。
      if (prepared) {
        await cleanPreparation(prepared.preflight.version, prepared.owned)
        prepared = null
      }
      if (!local) {
        const releases = await manifest(signal)
        const entry = releases.find((item) => item.version === version)
        if (!entry) throw new ManagerError('目标版本不在签名有效的正式版清单里', 'unknown_version')
        if (compareVersions(version, current()) <= 0) throw new ManagerError('目标版本必须比当前版本新', 'not_newer')
        if (pointer?.previous === version) throw new ManagerError('不能覆盖上一个版本', 'not_newer')
        if (entry.managerProtocol > MANAGER_PROTOCOL) {
          const pending = await pendingManager(home, options.bundled)
          const compatible = newerReleases(current(), releases).find((item) => item.managerProtocol <= MANAGER_PROTOCOL)
          throw new ManagerError(
            pending
              ? `先重启一次服务，让新的管理进程生效，再升级到 ${version}`
              : compatible
                ? `${version} 要求更新的管理进程：先升级到 ${compatible.version}，重启一次服务，再升级到 ${version}`
                : `${version} 要求更新的管理进程，一键升级做不到：覆盖解压它的 ZIP 来升级`,
            'manager_outdated',
          )
        }
        if (entry.minNode > (options.nodeMajor ?? Number(process.versions.node.split('.')[0])))
          throw new ManagerError(`目标版本需要 Node ${entry.minNode} 或更新版本，请先升级 Node`, 'node_too_old')
        step(2)
        const inspected = await doctor(current(), signal)
        await checkSpace(entry.size, inspected)
        step(3)
        owned = true
        await download(entry, join(staging, `${version}.zip`), {
          ...options,
          signal,
          onProgress(received, total) {
            if (operation) operation.progress = { received, total }
            options.onProgress?.(received, total)
          },
        })
        step(4)
        await extract(home, version, join(staging, `${version}.zip`), [current(), pointer?.previous ?? null], signal)
      } else {
        if (pointer && compareVersions(version, pointer.current) <= 0)
          throw new ManagerError('目标版本必须比当前版本新', 'not_newer')
        await verifyRelease(home, version)
      }
      step(5)
      const preflight = await doctor(version, signal)
      await checkSpace(0, preflight)
      signal.throwIfAborted()
      prepared = { preflight, from, kind, owned }
      return structuredClone(preflight)
    } catch (error) {
      const failedStep = operation?.step ?? 1
      await cleanPreparation(version, owned)
      if (error instanceof ConfigError) throw error
      await record({
        at: timestamp(),
        kind,
        from,
        to: version,
        result: 'failed',
        step: failedStep,
        reason: signal.aborted ? '操作已取消' : reason(error),
      })
      throw new ManagerError(
        signal.aborted ? '操作已取消' : reason(error),
        error instanceof ManagerError
          ? error.code
          : failedStep === 3 || failedStep === 4
            ? 'download_failed'
            : 'preflight_failed',
      )
    } finally {
      cancellation = null
      operation = null
    }
  }
  const restoreSqlite = async (preflight: Preflight, backup: string | null): Promise<void> => {
    if (!backup || !preflight.sqliteFile)
      throw new ManagerError('SQLite 升级前的备份不存在，请人工恢复数据库', 'backup_missing')
    try {
      await access(backup)
    } catch {
      throw new ManagerError('SQLite 升级前的备份不存在，请人工恢复数据库', 'backup_missing')
    }
    const temporary = `${preflight.sqliteFile}.${randomUUID()}.restore`
    try {
      await copyFile(backup, temporary)
      if (options.runAs) {
        let mode = 0o600
        try {
          mode = (await (options.stat ?? stat)(preflight.sqliteFile)).mode & 0o777
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await (options.chown ?? chown)(temporary, options.runAs.uid, options.runAs.gid)
        await chmod(temporary, mode)
      }
      await renameRetry(temporary, preflight.sqliteFile)
      await rm(`${preflight.sqliteFile}-wal`, { force: true })
      await rm(`${preflight.sqliteFile}-shm`, { force: true })
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
  const cleanup = async (clearStaging = true) => {
    if (!pointer) return
    await pruneReleases(home, pointer, options.log ?? console.error)
    if (clearStaging)
      await rm(staging, { recursive: true, force: true }).catch(() => log('暂时无法清空准备目录，下次再清理'))
  }
  const activateManager = async (version: string) => {
    const source = join(staging, `manager-${version}`)
    try {
      await access(source)
    } catch {
      return
    }
    await rm(join(home, 'manager.next'), { recursive: true, force: true })
    await renameRetry(source, join(home, 'manager.next'))
  }
  const restartOld = async (version: string) => {
    if (options.signal?.aborted) return false
    try {
      await supervisor.start(version, true)
      return true
    } catch {
      await supervisor.stop()
      return false
    }
  }
  return {
    status() {
      return structuredClone({
        current: current(),
        previous: pointer?.previous ?? null,
        operation,
        prepared: prepared?.preflight ?? null,
        lastResult,
      })
    },
    async check() {
      begin('check', current())
      try {
        const releases = newerReleases(current(), await manifest(options.signal))
        return releases.filter(
          (entry) =>
            !pointer?.failed.includes(entry.version) ||
            releases.some((item) => compareVersions(item.version, entry.version) > 0),
        )
      } finally {
        operation = null
      }
    },
    prepare: (version) => prepare(version),
    prepareLocal: (version, local = {}) => prepare(version, local),
    cancel() {
      if (operation?.kind === 'prepare') cancellation?.abort()
    },
    async apply(version, confirmation = {}): Promise<UpgradeResult> {
      begin('apply', version)
      let dataLock: Lock | null = null
      let stopped = false
      let migrations = false
      let backup: string | null = null
      let migrationAttempted = false
      let migrationSucceeded = false
      let accepted = false
      let before: Current | null = null
      const work = prepared
      if (!work || work.preflight.version !== version) {
        operation = null
        throw new ManagerError('请先准备这个版本', 'not_prepared')
      }
      const { preflight, from, kind } = work
      if (preflight.tier === 'external-backup' && !confirmation.backupConfirmed) {
        operation = null
        throw new ManagerError('有数据库迁移，必须先确认已备份外部数据库', 'backup_required')
      }
      const base = (): UpdateLog => ({
        at: timestamp(),
        kind,
        from,
        to: version,
        result: 'failed',
        step: operation?.step ?? 6,
        migrations,
        backup,
      })
      try {
        // doctor 是只读结果，准备后仍可能有命令行操作；停站前再核对一次，不能沿用过期的档位。
        const fresh = await doctor(version, options.signal)
        if (JSON.stringify(fresh) !== JSON.stringify(preflight))
          throw new ManagerError('预检结果已经变化，请重新准备升级', 'preflight_failed')
        pointer = await readCurrent(home)
        if (pointer && pointer.current !== from)
          throw new ManagerError('当前版本已经变化，请重新准备升级', 'preflight_failed')
        before = pointer ? structuredClone(pointer) : null
        step(7)
        await supervisor.stop()
        stopped = true
        dataLock = await lock(preflight)
        if (!dataLock) throw new ManagerError('管理进程正在停止')
        // 停站前的在途请求可能刚启用插件；未确认外部备份时必须在数据锁内再核对。
        if (preflight.dialect !== 'sqlite' && !confirmation.backupConfirmed) {
          const stoppedPreflight = await doctor(version, options.signal)
          if (JSON.stringify(stoppedPreflight) !== JSON.stringify(preflight))
            throw new ManagerError('停站期间有了新的数据库迁移，先备份，再重新准备并确认', 'backup_required')
        }
        step(8)
        migrationAttempted = true
        const report = await command(version, 'migrate', options.migrateTimeout ?? 30 * 60_000, options.signal)
        // 退出 0 但报告损坏也不能断言成功；失败恢复在数据锁内核对实际迁移状态。
        const result: MigrationResult = parseMigration(report)
        migrationSucceeded = true
        migrations = result.core.length > 0 || result.plugins.some((item) => item.migrations.length > 0)
        backup = result.backup
        // 有迁移却没有可恢复的 SQLite 备份时，不能再把它归到无迁移档。
        if (preflight.tier !== 'none') migrations = true
        if (migrations && preflight.dialect === 'sqlite' && !backup)
          throw new ManagerError('SQLite 迁移没有返回备份路径，请人工检查数据库', 'backup_missing')
        step(9)
        await save({
          ...(pointer ?? initialCurrent(version)),
          current: version,
          previous: kind === 'legacy' ? null : from,
          upgrades: { [version]: { from, migrations, dialect: preflight.dialect, backup } },
        })
        dataLock.release()
        dataLock = null
        step(10)
        await supervisor.start(version, true)
        accepted = true
        step(11)
        await save({ ...pointer!, bundled: version, failed: pointer!.failed.filter((item) => item !== version) })
        const entry = { ...base(), result: 'success' as const }
        await record(entry)
        prepared = null
        // 健康检查已经通过，后续清理失败不能把一个已接受写入的站点自动回滚。
        let clearStaging = true
        await activateManager(version).catch(() => {
          clearStaging = false
          log('新管理进程暂时无法放入 manager.next，已保留准备目录，请检查目录权限')
        })
        await cleanup(clearStaging).catch(() => log('旧版本暂时无法清理，下次再试'))
        return entry
      } catch (error) {
        if (error instanceof ConfigError && !stopped) throw error
        if (accepted) {
          prepared = null
          const entry = {
            ...base(),
            result: 'success' as const,
            reason: '新版本已通过健康检查，升级记录或清理未完成，请检查目录权限',
          }
          lastResult = entry
          await appendLog(home, entry).catch(() => log(entry.reason))
          return entry
        }
        const entry = base()
        entry.reason = reason(error)
        if (error instanceof MigrationError) {
          entry.error = error.detail
          backup = error.backup
          entry.backup = backup
        }
        if (stopped) {
          try {
            let partial: 'changed' | 'unchanged' | 'unknown' | null = null
            if (migrationAttempted && !migrationSucceeded) {
              if (error instanceof MigrationError && (error.core.length || error.plugins.length)) partial = 'changed'
              else {
                try {
                  // migrate 可能在返回报告前崩溃，只有持锁复查待执行项才能区分未变和部分提交。
                  const after = await doctor(version, options.signal)
                  partial =
                    JSON.stringify([after.pendingCore, after.pendingPlugins]) ===
                    JSON.stringify([preflight.pendingCore, preflight.pendingPlugins])
                      ? 'unchanged'
                      : 'changed'
                } catch {
                  partial = 'unknown'
                }
              }
              migrations = partial !== 'unchanged'
              entry.migrations = migrations
              if (partial === 'unknown') entry.reason += '；无法确认数据库是否已经部分迁移'
            }
            const externalChanged =
              (migrationSucceeded && migrations && preflight.dialect !== 'sqlite') ||
              (partial === 'changed' && !(preflight.dialect === 'sqlite' && backup))
            if (externalChanged) {
              dataLock?.release()
              dataLock = null
              // 若指针写入失败，仍尽力指向已迁移的程序；决不拿旧程序打开新库。
              if (pointer?.current !== version)
                await save({
                  ...(before ?? initialCurrent(version)),
                  current: version,
                  previous: kind === 'legacy' ? null : from,
                  upgrades: { [version]: { from, migrations, dialect: preflight.dialect, backup } },
                })
              supervisor.resume(version)
              entry.reason +=
                partial === 'changed'
                  ? '；数据库已经部分迁移，新版本保留，需要管理员用升级前的备份恢复'
                  : '；数据库已经迁移，新版本保留运行，需要管理员人工处理'
            } else {
              await supervisor.stop()
              if (
                preflight.dialect === 'sqlite' &&
                ((migrationSucceeded && migrations) || (partial !== null && backup))
              ) {
                dataLock ??= await lock(preflight)
                if (!dataLock) throw new ManagerError('管理进程正在停止，数据库尚未恢复')
                await restoreSqlite(preflight, backup)
              }
              if (before) await save(before)
              else {
                await rm(join(home, 'releases/current.json'), { force: true })
                pointer = null
              }
              dataLock?.release()
              dataLock = null
              if (kind !== 'legacy' && (await restartOld(from))) entry.result = 'rolled-back'
              else if (kind !== 'legacy')
                entry.reason +=
                  migrationAttempted && ['mysql', 'mariadb'].includes(preflight.dialect)
                    ? '；旧版本健康检查失败，请用升级前的备份恢复数据库'
                    : '；旧版本未能恢复运行，请人工检查'
            }
          } catch (recoveryError) {
            entry.reason += `；${reason(recoveryError)}`
          }
        }
        if (kind === 'legacy') entry.reason += '；请照 ADR-0040 手工回退，解压旧版本的 ZIP'
        if (migrationAttempted) await markFailed(version)
        await record(entry)
        if (stopped) prepared = null
        return entry
      } finally {
        dataLock?.release()
        operation = null
      }
    },
    async rollback(confirmation = {}): Promise<UpgradeResult> {
      if (operation) throw new ManagerError('已有管理操作正在进行', 'busy')
      if (options.writable === false) throw new ManagerError('实例目录不可写', 'readonly')
      const latest = await readCurrent(home)
      const version = latest?.previous
      if (!latest || !version) throw new ManagerError('没有可回滚的上一个版本', 'no_previous')
      begin('rollback', version)
      const from = latest.current
      const upgrade = latest.upgrades[from]
      // 外部库有迁移的回滚只由停着服务的命令行执行，控制通道拒绝（ADR-0061"回滚"）
      const external = !!upgrade?.migrations && upgrade.dialect !== 'sqlite'
      let dataLock: Lock | null = null
      let stopped = false
      let databaseRestored = false
      let switched = false
      let accepted = false
      const entry: UpdateLog = {
        at: timestamp(),
        kind: 'rollback',
        from,
        to: version,
        result: 'failed',
        step: 6,
        migrations: upgrade?.migrations ?? false,
        backup: upgrade?.backup ?? null,
      }
      try {
        try {
          await access(join(home, 'releases', version))
        } catch {
          throw new ManagerError('没有可回滚的上一个版本目录', 'no_previous')
        }
        if (upgrade?.migrations && !confirmation.confirmed)
          throw new ManagerError(
            upgrade.dialect === 'sqlite'
              ? '升级以后的所有写入都会丢失，请确认后回滚'
              : '请先恢复数据库，并确认库已经由管理员恢复到升级之前',
            'confirmation_required',
          )
        if (upgrade?.migrations && upgrade.dialect === 'sqlite') {
          if (!upgrade.backup) throw new ManagerError('SQLite 升级前的备份不存在', 'backup_missing')
          try {
            await access(upgrade.backup)
          } catch {
            throw new ManagerError('SQLite 升级前的备份不存在', 'backup_missing')
          }
        }
      } catch (error) {
        operation = null
        throw error
      }
      try {
        await verifyRelease(home, version)
        // 回滚外部库时，当前版本的 doctor 会因库已恢复而与升级时不同；用目标版本做只读检查。
        const preflight = await doctor(
          upgrade?.migrations && upgrade.dialect === 'sqlite' ? from : version,
          options.signal,
        )
        if (preflight.tier !== 'none')
          throw new ManagerError('回滚目标仍有待执行迁移，请检查数据库是否已经恢复', 'preflight_failed')
        step(7)
        entry.step = 7
        await supervisor.stop()
        stopped = true
        dataLock = await lock(preflight).catch((error: unknown) => {
          // 拿不到数据锁：服务没经管理进程在跑（NEXTSKIN_MANAGER=off，或直接运行了某个版本的启动器）
          if (!external) throw error
          throw new ManagerError(
            '服务还在运行，没有回滚：先停掉服务。服务在线时恢复的数据库可能又被写过，要再用升级前的备份恢复一次',
            'offline_required',
          )
        })
        if (!dataLock) throw new ManagerError('管理进程正在停止')
        if (upgrade?.migrations && upgrade.dialect === 'sqlite') {
          step(8)
          entry.step = 8
          await restoreSqlite(preflight, upgrade.backup)
          databaseRestored = true
        }
        step(9)
        entry.step = 9
        await save({ ...latest, current: version, previous: null, upgrades: {} })
        switched = true
        dataLock.release()
        dataLock = null
        step(10)
        entry.step = 10
        await supervisor.start(version, true)
        accepted = true
        entry.result = 'success'
        entry.step = 11
        prepared = null
        await record(entry)
        await cleanup().catch(() => log('旧版本暂时无法清理，下次再试'))
        return entry
      } catch (error) {
        if (error instanceof ConfigError && !stopped) throw error
        if (accepted) {
          entry.reason = '回滚目标已通过健康检查，日志记录未完成，请检查目录权限'
          lastResult = entry
          log(entry.reason)
          return entry
        }
        entry.reason = reason(error)
        if (stopped) {
          await supervisor.stop()
          // SQLite 在换回备份之前失败时库和指针都没动，可以照旧起当前版本；外部库已经由管理员恢复，不能再起要求新 schema 的程序
          if (!databaseRestored && (!upgrade?.migrations || (!switched && !external))) {
            await save(latest)
            dataLock?.release()
            dataLock = null
            if (await restartOld(from)) entry.result = 'rolled-back'
          } else if (databaseRestored || switched) {
            // 库已经回到升级前，不能为了恢复服务再启动要求新 schema 的程序。
            entry.reason += '；数据库已经恢复或由管理员处理，请人工检查回滚目标'
          }
        }
        await record(entry)
        return entry
      } finally {
        dataLock?.release()
        operation = null
      }
    },
  }
}
