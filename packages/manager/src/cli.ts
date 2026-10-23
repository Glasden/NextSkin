import { constants } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { compareVersions } from '@nextskin/updates'
import { connectControl, managerStatus } from './control.ts'
import { logRunAs, resolveRunAs } from './run-as.ts'
import { readLegacyVersion, removeLegacy } from './start.ts'
import { acquireLock } from './lock.ts'
import { createManager, type ManagerOptions } from './pipeline.ts'
import { readCurrent, sleep, validVersion } from './state.ts'
import { ConfigError, ManagerError, reason, type Manager, type ManagerStatus } from './types.ts'

export const managerHelp = `管理进程的命令（升级和回滚，ADR-0061）：
  update [--to <版本>]     升级，默认到最新的正式版；不再询问加 --yes，
                           MySQL、PostgreSQL 有迁移时先备份、再加 --backup-confirmed
  update --check           列出比当前新的正式版
  update status            当前版本、进行中的操作和最近一次的结果
  rollback [--yes]         回到上一个版本
  releases                 列出本机的版本目录
update --check、update status、releases 加 --json 输出机器可读的结果。
`

export interface CliOptions {
  manager?: Omit<ManagerOptions, 'home' | 'bundled' | 'supervisor'>
  output?: (line: string) => void
  error?: (line: string) => void
  isTTY?: boolean
  confirm?: (message: string) => Promise<boolean>
  pollInterval?: number
}
const offlineSupervisor = {
  async start() {},
  async stop() {},
  resume() {},
}
function parse(argv: string[]) {
  const parsed = (() => {
    try {
      return parseArgs({
        args: argv.slice(1),
        strict: true,
        allowPositionals: true,
        options: {
          json: { type: 'boolean' },
          check: { type: 'boolean' },
          to: { type: 'string' },
          yes: { type: 'boolean' },
          'backup-confirmed': { type: 'boolean' },
        },
      })
    } catch {
      throw new ManagerError('命令参数不合法，请运行 help', 'invalid_request')
    }
  })()
  const command = argv[0]
  const { positionals, values } = parsed
  const status = command === 'update' && positionals[0] === 'status'
  const allowed =
    command === 'releases' || status
      ? ['json']
      : command === 'rollback'
        ? ['yes']
        : values.check
          ? ['check', 'json']
          : ['to', 'yes', 'backup-confirmed']
  if (
    !['update', 'rollback', 'releases'].includes(command ?? '') ||
    positionals.length !== (status ? 1 : 0) ||
    Object.keys(values).some((key) => !allowed.includes(key)) ||
    (values.to !== undefined && !validVersion(values.to))
  )
    throw new ManagerError('命令参数不合法，请运行 help', 'invalid_request')
  return { command, status, values }
}

export async function runManagementCommand(
  home: string,
  bundled: string,
  argv: string[],
  options: CliOptions = {},
): Promise<number> {
  const output = options.output ?? console.log
  const errorOutput = options.error ?? console.error
  try {
    const { command, status: statusCommand, values } = parse(argv)
    let runtime = options.manager ?? {}
    const makeManager = () =>
      createManager({ ...runtime, home, bundled, supervisor: offlineSupervisor, checkDataOwner: true })
    if (values.check) {
      const releases = await (await makeManager()).check()
      if (values.json) output(JSON.stringify(releases))
      else
        output(
          releases.length
            ? releases.map((entry) => `${entry.version}  ${entry.date}  ${entry.notes}`).join('\n')
            : '没有更新的正式版',
        )
      return 0
    }
    const remote = await connectControl(home)
    const getRemoteStatus = async () => (await remote!('status', {})) as ManagerStatus
    if (command === 'releases') {
      const pointer = await readCurrent(home)
      const releases = (await readdir(join(home, 'releases'), { withFileTypes: true }))
        .filter((item) => item.isDirectory() && validVersion(item.name))
        .map((item) => ({
          version: item.name,
          current: item.name === (pointer?.current ?? bundled),
          previous: item.name === pointer?.previous,
          bundled: item.name === bundled,
          failed: pointer?.failed.includes(item.name) ?? false,
        }))
        .sort((a, b) => compareVersions(b.version, a.version))
      if (values.json) output(JSON.stringify({ running: !!remote, releases }))
      else
        output(
          `管理进程：${remote ? '运行中' : '未运行'}\n${releases.map((entry) => `${entry.version}  ${(['current', 'previous', 'bundled', 'failed'] as const).filter((key) => entry[key]).join(', ')}`).join('\n')}`,
        )
      return 0
    }
    if (statusCommand) {
      let writable = false
      if (!remote) {
        try {
          await access(join(home, 'releases'), constants.W_OK)
          writable = true
        } catch {
          /* 只读查询仍可报告版本。 */
        }
      }
      const value = remote
        ? await getRemoteStatus()
        : await managerStatus(home, bundled, await makeManager(), writable, false)
      if (values.json) output(JSON.stringify(value))
      else {
        output(`管理进程：${remote ? '运行中' : '未运行'}；当前：${value.current}；上一个：${value.previous ?? '无'}`)
        output(`管理版本：${value.version}；协议：${value.protocol}；可写：${value.writable ? '是' : '否'}`)
        output(
          value.operation
            ? `操作：${value.operation.kind} ${value.operation.version ?? ''} ${value.operation.step}${value.operation.progress ? ` ${value.operation.progress.received}/${value.operation.progress.total} 字节` : ''}`
            : '当前没有管理操作',
        )
        output(
          value.prepared
            ? `已准备：${value.prepared.version}；${value.prepared.preflight.dialect}；核心迁移 ${value.prepared.preflight.pendingCore} 条；插件迁移 ${value.prepared.preflight.pendingPlugins} 条；档位 ${value.prepared.preflight.tier}`
            : '没有已准备版本',
        )
        output(`失败版本：${value.failed.join('、') || '无'}`)
        printResult(value.lastResult)
      }
      return 0
    }
    let manager: Manager | undefined
    let lock: Awaited<ReturnType<typeof acquireLock>> = null
    if (!remote) {
      const runAs = runtime.runAs ?? resolveRunAs(runtime)
      runtime = { ...runtime, runAs }
      logRunAs(runAs, errorOutput)
      try {
        await access(join(home, 'releases'), constants.W_OK)
      } catch {
        throw new ConfigError('releases 目录不可写，无法升级或回滚')
      }
      try {
        lock = await acquireLock(join(home, 'releases/manager.lock'))
      } catch {
        throw new ConfigError('无法创建管理进程锁，请检查目录权限')
      }
      if (!lock) throw new ManagerError('另一个管理进程在运行，但控制通道连不上，请检查服务状态', 'busy')
    }
    try {
      if (!remote) manager = await makeManager()
      const getStatus = remote ? getRemoteStatus : () => managerStatus(home, bundled, manager!, true, false)
      if (command === 'rollback') {
        const value = await getStatus()
        const rollback = value.rollback
        if (!rollback) throw new ManagerError('没有可回滚的上一个版本', 'no_previous')
        if (rollback.migrations)
          output(
            rollback.dialect === 'sqlite'
              ? '升级以后的所有写入都会丢失'
              : '先用升级前的备份恢复数据库，再确认库已经恢复到升级之前',
          )
        await confirm(`确认回滚到 ${rollback.version}？[y/N] `)
        if (remote) {
          await remote('rollback', { confirmed: true })
          const finished = await poll(getStatus, 'rollback', rollback.version)
          printResult(finished.lastResult)
          return finished.lastResult?.result === 'success' ? 0 : 1
        }
        const result = await manager!.rollback({ confirmed: true })
        printResult((await getStatus()).lastResult)
        return result.result === 'success' ? 0 : 1
      }
      const legacy = remote ? null : await readLegacyVersion(home)
      let target = values.to
      if (legacy) {
        if (target && target !== bundled)
          throw new ManagerError('旧布局要先换到已解压的自带版本，再选择其他版本', 'invalid_request')
        target ??= bundled
      } else if (!remote && !target) {
        const pointer = await readCurrent(home)
        if (
          pointer &&
          compareVersions(bundled, pointer.current) > 0 &&
          (await readdir(join(home, 'releases'))).includes(bundled)
        )
          target = bundled
      }
      if (!target) {
        const releases = await (await makeManager()).check()
        target = releases[0]?.version
        if (!target) {
          output('没有更新的正式版')
          return 0
        }
      }
      if (remote) {
        await remote('prepare', { version: target })
        await poll(getStatus, 'prepare', target)
      } else {
        const value = await getStatus()
        if (legacy) await manager!.prepareLocal(bundled, { from: legacy, legacy: true })
        else if (
          target === bundled &&
          compareVersions(target, value.current) > 0 &&
          (await readdir(join(home, 'releases'))).includes(target)
        )
          await manager!.prepareLocal(target)
        else await manager!.prepare(target)
      }
      const prepared = (await getStatus()).prepared
      if (!prepared || prepared.version !== target) throw new ManagerError('目标版本没有准备完成', 'not_prepared')
      const preflight = prepared.preflight
      output(
        `预检：${preflight.dialect}；核心迁移 ${preflight.pendingCore} 条；插件迁移 ${preflight.pendingPlugins} 条；档位 ${preflight.tier}`,
      )
      output(
        `不兼容的插件：${preflight.incompatiblePlugins.map((plugin) => `${plugin.id} (${plugin.api})`).join('、') || '无'}`,
      )
      output('预计停站几秒到三十多秒；实际时间取决于数据库迁移，健康检查最多等待两分钟')
      if (preflight.tier === 'external-backup' && !values['backup-confirmed'])
        throw new ManagerError('外部数据库有迁移，请先自行备份，再加 --backup-confirmed 确认', 'backup_required')
      await confirm(`确认升级到 ${target}？[y/N] `)
      if (remote) {
        await remote('apply', { version: target, backupConfirmed: !!values['backup-confirmed'] })
        const finished = await poll(getStatus, 'apply', target)
        printResult(finished.lastResult)
        return finished.lastResult?.result === 'success' ? 0 : 1
      }
      const result = await manager!.apply(target, { backupConfirmed: !!values['backup-confirmed'] })
      printResult((await getStatus()).lastResult)
      if (legacy && result.result === 'success') await removeLegacy(home, errorOutput)
      return result.result === 'success' ? 0 : 1
    } finally {
      lock?.release()
    }

    async function confirm(message: string) {
      if (values.yes) return
      if (!(options.isTTY ?? process.stdin.isTTY)) throw new ManagerError('非 TTY 输入必须加 --yes 确认')
      const accepted = options.confirm ? await options.confirm(message) : await ask(message)
      if (!accepted) throw new ManagerError('已取消操作')
    }
    async function poll(
      getStatus: () => Promise<ManagerStatus>,
      kind: 'prepare' | 'apply' | 'rollback',
      version: string,
    ) {
      let lastStep = ''
      for (;;) {
        const value = await getStatus()
        const operation = value.operation
        if (operation) {
          const display = `${operation.step}${operation.progress ? ` ${operation.progress.received}/${operation.progress.total} 字节` : ''}`
          if (display !== lastStep) {
            output(display)
            lastStep = display
          }
        } else if (kind === 'prepare' && value.prepared?.version === version) return value
        else {
          if (kind === 'prepare') throw new ManagerError(value.lastResult?.reason ?? '准备失败')
          return value
        }
        await sleep(options.pollInterval ?? 500)
      }
    }
    function printResult(value: ManagerStatus['lastResult']) {
      output(
        value
          ? `${value.kind} ${value.from ?? '无'} → ${value.to}：${value.result}${value.reason ? `；${value.reason}` : ''}`
          : '最近没有升级记录',
      )
    }
  } catch (error) {
    errorOutput(`[nextskin] ${reason(error)}`)
    return error instanceof ConfigError ? 78 : 1
  }
}
async function ask(message: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(?:es)?$/i.test((await readline.question(message)).trim())
  } finally {
    readline.close()
  }
}
