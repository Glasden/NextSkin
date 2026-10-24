import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, createConnection, type Socket } from 'node:net'
import { access, chmod, chown, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Logger } from '@nextskin/logging'
import { MANAGER_PROTOCOL, compareVersions } from '@nextskin/updates'
import { appendLog, pendingManager, readCurrent, renameRetry, validVersion } from './state.ts'
import type { RunAs } from './run-as.ts'
import {
  ManagerError,
  object,
  offlineRollbackMessage,
  reason,
  type Manager,
  type ManagerStatus,
  type UpdateLog,
} from './types.ts'
import { managerLogger } from './log.ts'

const limit = 64 * 1024
export const steps = [
  '',
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
]
const stepName = (step: number) => steps[step] || null
const publicDialect = (dialect: 'sqlite' | 'mysql' | 'mariadb' | 'postgres') =>
  dialect === 'mariadb' ? 'mysql' : dialect

export function controlAddress(home: string, platform = process.platform): string {
  const absolute = resolve(home)
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 16)
  if (platform === 'win32') return `\\\\.\\pipe\\nextskin-${hash}`
  const socket = join(absolute, 'releases/manager.sock')
  return Buffer.byteLength(socket) > 100 ? join(tmpdir(), `nextskin-${hash}.sock`) : socket
}
async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}
export async function managerStatus(
  home: string,
  bundled: string,
  manager: Manager,
  writable: boolean,
  redact = true,
): Promise<ManagerStatus> {
  const state = manager.status()
  const pointer = await readCurrent(home)
  const upgrade = pointer?.upgrades[pointer.current]
  const prepared = state.prepared
  const entry = state.lastResult
  return {
    protocol: MANAGER_PROTOCOL,
    pendingManager: await pendingManager(home, bundled),
    version: bundled,
    current: state.current,
    previous: pointer?.previous ?? null,
    writable,
    operation:
      state.operation && state.operation.kind !== 'check'
        ? {
            kind: state.operation.kind,
            version: state.operation.version,
            step: stepName(state.operation.step) ?? 'manifest',
            startedAt: state.operation.startedAt,
            ...(state.operation.progress ? { progress: state.operation.progress } : {}),
          }
        : null,
    prepared: prepared
      ? {
          version: prepared.version,
          preflight: {
            dialect: publicDialect(prepared.dialect),
            pendingCore: prepared.pendingCore.length,
            pendingPlugins: prepared.pendingPlugins.reduce((sum, item) => sum + item.migrations.length, 0),
            tier: prepared.tier,
            incompatiblePlugins: prepared.incompatiblePlugins,
          },
        }
      : null,
    lastResult: publicResult(entry, redact),
    failed: pointer?.failed ?? [],
    rollback: pointer?.previous
      ? {
          version: pointer.previous,
          migrations: upgrade?.migrations ?? false,
          dialect: upgrade ? publicDialect(upgrade.dialect) : null,
          backupAvailable: !!(
            upgrade?.migrations &&
            upgrade.dialect === 'sqlite' &&
            upgrade.backup &&
            (await exists(upgrade.backup))
          ),
        }
      : null,
  }
}
/** 只在控制通道边界去掉本机路径；持久日志和离线命令行仍供管理员定位问题。 */
export function redactPaths(message: string): string {
  return message.replace(
    /[a-z][a-z\d+.-]*:\/\/[^\s，。；：、（）"'`“”‘’]+|(?:[a-z]:[\\/]|\\\\|(?<![a-z\d_./:\\-])\/)[^\s，。；：、（）"'`“”‘’]+/gi,
    (value) => (/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : '<路径>'),
  )
}
function publicResult(entry: UpdateLog | null, redact = true): ManagerStatus['lastResult'] {
  return entry
    ? {
        at: entry.at,
        kind: entry.kind,
        from: entry.from,
        to: entry.to,
        result: entry.result,
        step: stepName(entry.step),
        reason: entry.reason === undefined ? null : redact ? redactPaths(entry.reason) : entry.reason,
      }
    : null
}
export type ControlMethod = 'status' | 'prepare' | 'apply' | 'rollback' | 'cancel'
export type ControlResponse = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }
function invalid(): never {
  throw new ManagerError('控制请求格式不合法', 'invalid_request')
}
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    invalid()
}
function request(value: unknown, token: string): { method: ControlMethod; params: Record<string, unknown> } {
  fields(value, ['token', 'method', 'params'])
  if (typeof value.token !== 'string' || typeof value.method !== 'string') invalid()
  const supplied = Buffer.from(value.token)
  const expected = Buffer.from(token)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new ManagerError('控制通道令牌不正确', 'unauthorized')
  const method = value.method
  if (method === 'status' || method === 'cancel') fields(value.params, [])
  else if (method === 'prepare' || method === 'apply') {
    fields(value.params, method === 'apply' ? ['version', 'backupConfirmed'] : ['version'])
    if (
      !validVersion(value.params.version) ||
      (method === 'apply' && typeof value.params.backupConfirmed !== 'boolean')
    )
      invalid()
  } else if (method === 'rollback') {
    fields(value.params, ['confirmed'])
    if (typeof value.params.confirmed !== 'boolean') invalid()
  } else invalid()
  return { method, params: value.params }
}
export function validateOperation(
  status: ManagerStatus,
  method: 'prepare' | 'apply' | 'rollback',
  params: Record<string, unknown>,
  busy = false,
): void {
  if (busy || status.operation) throw new ManagerError('已有管理操作正在进行', 'busy')
  if (!status.writable) throw new ManagerError('实例目录不可写', 'readonly')
  if (method === 'apply') {
    if (!status.prepared || status.prepared.version !== params.version)
      throw new ManagerError('请先准备这个版本', 'not_prepared')
    if (status.prepared.preflight.tier === 'external-backup' && params.backupConfirmed !== true)
      throw new ManagerError('有数据库迁移，必须先确认已备份外部数据库', 'backup_required')
  }
  if (method === 'rollback') {
    if (!status.rollback) throw new ManagerError('没有可回滚的上一个版本', 'no_previous')
    if (status.rollback.migrations && status.rollback.dialect !== 'sqlite')
      throw new ManagerError(offlineRollbackMessage, 'offline_required')
    if (status.rollback.migrations && params.confirmed !== true)
      throw new ManagerError('有数据库迁移，请先确认回滚及数据库恢复要求', 'confirmation_required')
    if (status.rollback.migrations && status.rollback.dialect === 'sqlite' && !status.rollback.backupAvailable)
      throw new ManagerError('SQLite 升级前的备份不存在', 'backup_missing')
  }
}

/** 调用方持有 manager.lock；接受切换后等响应关闭再停核心，避免调用方收不到结果。 */
export async function createControl(options: {
  home: string
  bundled: string
  manager: Manager
  writable?: boolean
  runAs?: RunAs
  chown?: typeof chown
  log?: Logger
}): Promise<{ address: string; token: string; close(this: void): Promise<void> }> {
  const { home, bundled, manager } = options
  const writable = options.writable !== false
  const address = controlAddress(home)
  const token = randomBytes(32).toString('hex')
  const tokenFile = join(home, 'releases/manager.token')
  const temporary = `${tokenFile}.${randomBytes(8).toString('hex')}.tmp`
  const sockets = new Set<Socket>()
  let reserved: ManagerStatus['operation'] = null
  let background: Promise<unknown> | undefined
  let closed = false
  let preparationCancelled = false
  let fallback: { before: string; entry: UpdateLog } | null = null
  const status = async () => {
    const value = await managerStatus(home, bundled, manager, writable)
    if (fallback) {
      if (JSON.stringify(manager.status().lastResult) === fallback.before)
        value.lastResult = publicResult(fallback.entry)
      else fallback = null
    }
    if (!value.operation && reserved) value.operation = reserved
    return value
  }
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    let disconnected = false
    socket.once('close', () => {
      disconnected = true
      sockets.delete(socket)
    })
    let chunks = Buffer.alloc(0)
    let handled = false
    const timer = setTimeout(() => socket.destroy(), 5000)
    socket.once('close', () => clearTimeout(timer))
    socket.on('data', (chunk: Buffer) => {
      if (handled) return
      chunks = Buffer.concat([chunks, chunk])
      const newline = chunks.indexOf(10)
      if ((newline < 0 && chunks.length > limit) || newline > limit) {
        socket.destroy()
        return
      }
      if (newline < 0) return
      handled = true
      clearTimeout(timer)
      socket.pause()
      void (async () => {
        let run: (() => Promise<unknown>) | undefined
        let context: Pick<UpdateLog, 'kind' | 'from' | 'to'> | undefined
        let response: ControlResponse
        try {
          let body: unknown
          try {
            body = JSON.parse(chunks.subarray(0, newline).toString('utf8'))
          } catch {
            invalid()
          }
          const { method, params } = request(body, token)
          if (method === 'status') response = { ok: true, result: await status() }
          else if (method === 'cancel') {
            const cancelled = manager.status().operation?.kind === 'prepare' || reserved?.kind === 'prepare'
            if (cancelled) {
              preparationCancelled = true
              manager.cancel()
            }
            response = { ok: true, result: { cancelled } }
          } else {
            const value = await status()
            validateOperation(value, method, params, !!reserved || !!manager.status().operation)
            if (method === 'rollback' && !(await exists(join(home, 'releases', value.rollback!.version))))
              throw new ManagerError('没有可回滚的上一个版本目录', 'no_previous')
            // 上面的文件检查会让出事件循环，预留必须再次核对，以免两个连接同时被接受。
            if (reserved || manager.status().operation) throw new ManagerError('已有管理操作正在进行', 'busy')
            reserved = {
              kind: method,
              version: method === 'rollback' ? value.rollback!.version : String(params.version),
              step: method === 'prepare' ? 'manifest' : 'confirm',
              startedAt: new Date().toISOString(),
            }
            if (method === 'prepare') preparationCancelled = false
            context = {
              kind: method === 'rollback' ? 'rollback' : params.version === bundled ? 'manual' : 'update',
              from: value.current,
              to: reserved.version!,
            }
            run = async () => {
              if (method === 'apply')
                return manager.apply(String(params.version), { backupConfirmed: params.backupConfirmed === true })
              if (method === 'rollback') return manager.rollback({ confirmed: params.confirmed === true })
              const version = String(params.version)
              const local =
                version === bundled &&
                compareVersions(version, value.current) > 0 &&
                (await exists(join(home, 'releases', version)))
              if (preparationCancelled) throw new ManagerError('操作已取消')
              return local ? manager.prepareLocal(version) : manager.prepare(version)
            }
            response = { ok: true, result: { accepted: true } }
          }
        } catch (error) {
          response = {
            ok: false,
            error: {
              code: error instanceof ManagerError ? error.code : 'internal',
              message: redactPaths(reason(error)),
            },
          }
        }
        if (run) {
          if (disconnected) {
            reserved = null
            return
          }
          const action = run
          const operationContext = context!
          socket.once('close', () => {
            const before = JSON.stringify(manager.status().lastResult)
            background = (closed ? Promise.resolve() : action())
              .catch(async (error: unknown) => {
                // 确认后备份仍可能被移走；流水线在前置条件处拒绝时，也要让轮询看到失败。
                if (JSON.stringify(manager.status().lastResult) !== before) return
                const entry: UpdateLog = {
                  ...operationContext,
                  at: new Date().toISOString(),
                  result: 'failed',
                  step: Math.max(1, steps.indexOf(reserved?.step ?? 'confirm')),
                  reason: reason(error),
                }
                fallback = { before, entry }
                await appendLog(home, entry).catch(() => {})
              })
              .finally(() => {
                reserved = null
              })
          })
        }
        const line = JSON.stringify(response) + '\n'
        if (Buffer.byteLength(line) > limit) {
          socket.end(
            JSON.stringify({ ok: false, error: { code: 'internal', message: '管理状态过大，无法通过控制通道返回' } }) +
              '\n',
            () => socket.destroy(),
          )
        } else socket.end(line, () => socket.destroy())
      })().catch(() => socket.destroy())
    })
  })
  const cleanup = async () => {
    if (process.platform !== 'win32') await rm(address, { force: true })
    await rm(tokenFile, { force: true })
    await rm(temporary, { force: true })
  }
  try {
    if (process.platform !== 'win32') {
      if (address !== join(resolve(home), 'releases/manager.sock'))
        (options.log ?? managerLogger()).warn('实例路径过长，控制 socket 改用临时目录')
      await rm(address, { force: true })
    }
    await writeFile(temporary, token + '\n', { flag: 'wx', mode: 0o600 })
    if (process.platform !== 'win32') await chmod(temporary, 0o600)
    await renameRetry(temporary, tokenFile)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') {
      if (options.runAs) await (options.chown ?? chown)(address, 0, options.runAs.gid)
      await chmod(address, options.runAs ? 0o660 : 0o600)
    }
  } catch (error) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await cleanup()
    throw error
  }
  return {
    address,
    token,
    async close() {
      closed = true
      manager.cancel()
      const closing = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closing
      await background
      await cleanup()
    },
  }
}

export async function connectControl(
  home: string,
): Promise<((method: ControlMethod, params: Record<string, unknown>) => Promise<unknown>) | null> {
  let token: string
  try {
    token = (await readFile(join(home, 'releases/manager.token'), 'utf8')).trim()
  } catch {
    return null
  }
  const call = (method: ControlMethod, params: Record<string, unknown>) =>
    controlRequest(controlAddress(home), token, method, params)
  try {
    await call('status', {})
    return call
  } catch {
    return null
  }
}
export function controlRequest(
  address: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address)
    let data = Buffer.alloc(0)
    let result: ControlResponse | undefined
    let error: Error | undefined
    const timer = setTimeout(() => {
      error = new ManagerError('控制通道响应超时')
      socket.destroy()
    }, 5000)
    socket.once('connect', () => socket.write(JSON.stringify({ token, method, params }) + '\n'))
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk])
      const end = data.indexOf(10)
      if ((end < 0 && data.length > limit) || end > limit) {
        error = new ManagerError('控制通道响应过大')
        socket.destroy()
        return
      }
      if (end >= 0) {
        try {
          result = JSON.parse(data.subarray(0, end).toString('utf8')) as ControlResponse
        } catch {
          error = new ManagerError('控制通道响应不合法')
          socket.destroy()
        }
      }
    })
    socket.once('error', () => {
      error = new ManagerError('无法连接管理进程')
    })
    socket.once('close', () => {
      clearTimeout(timer)
      if (error) reject(error)
      else if (!result) reject(new ManagerError('控制通道没有完整响应'))
      else if (!result.ok) reject(new ManagerError(result.error.message, result.error.code as ManagerError['code']))
      else resolve(result.result)
    })
  })
}
