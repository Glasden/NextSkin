import { isAbsolute } from 'node:path'
import { ManagerError, dialect, object, strings, type MigrationResult, type Preflight } from './types.ts'
import type { CommandResult } from './process.ts'

export function pluginMigrations(value: unknown): value is MigrationResult['plugins'] {
  return (
    Array.isArray(value) &&
    value.every((row: unknown) => object(row) && typeof row.plugin === 'string' && strings(row.migrations))
  )
}
function incomplete(): never {
  throw new ManagerError('预检结果不完整，请重新解压完整发行包', 'preflight_failed')
}
export function parsePreflight(version: string, command: CommandResult): Preflight {
  let body: unknown
  try {
    body = JSON.parse(command.stdout)
  } catch {
    return incomplete()
  }
  if (!object(body) || !Array.isArray(body.results)) return incomplete()
  const results = body.results
  if (
    !results.every(
      (row: unknown) =>
        object(row) &&
        typeof row.id === 'string' &&
        typeof row.message === 'string' &&
        ['pass', 'warning', 'fail', 'skip'].includes(String(row.status)),
    )
  )
    return incomplete()
  const rows = results as { id: string; message: string; status: string }[]
  const failed = rows.filter((row) => row.id !== 'service' && row.status === 'fail')
  if (failed.length)
    throw new ManagerError(`预检失败：${failed.map((row) => row.message).join('；')}`, 'preflight_failed')
  for (const id of [
    'node',
    'envFile',
    'secret',
    'config',
    'dataDirectory',
    'database',
    'release',
    'pluginHost',
    'service',
  ]) {
    if (!rows.some((row) => row.id === id && (row.status !== 'skip' || id === 'service'))) return incomplete()
  }
  const db = body.database
  if (
    !object(db) ||
    !dialect(db.dialect) ||
    !strings(db.pendingCore) ||
    !pluginMigrations(db.pendingPlugins) ||
    !(
      strings(db.unknownCore) ||
      (typeof db.unknownCore === 'number' && Number.isSafeInteger(db.unknownCore) && db.unknownCore >= 0)
    ) ||
    typeof body.dataDirectory !== 'string' ||
    !isAbsolute(body.dataDirectory) ||
    !(db.sqliteFile === null || (typeof db.sqliteFile === 'string' && isAbsolute(db.sqliteFile))) ||
    (db.dialect === 'sqlite' && typeof db.sqliteFile !== 'string') ||
    !Array.isArray(db.incompatiblePlugins) ||
    !db.incompatiblePlugins.every(
      (row: unknown) => object(row) && typeof row.id === 'string' && typeof row.api === 'string',
    )
  )
    return incomplete()
  if ((typeof db.unknownCore === 'number' ? db.unknownCore : db.unknownCore.length) > 0)
    throw new ManagerError('库比这个版本新，有程序不认识的核心迁移，拒绝升级', 'preflight_failed')
  // 服务仍在运行时它的健康状态与目标版本能否打开库无关；只有这一项失败可以忽略。
  if (command.code !== 0 && !rows.some((row) => row.id === 'service' && row.status === 'fail')) return incomplete()
  const migrations = db.pendingCore.length + db.pendingPlugins.reduce((sum, row) => sum + row.migrations.length, 0)
  return {
    version,
    dataDirectory: body.dataDirectory,
    sqliteFile: db.sqliteFile,
    dialect: db.dialect,
    pendingCore: db.pendingCore,
    pendingPlugins: db.pendingPlugins,
    incompatiblePlugins: db.incompatiblePlugins as Preflight['incompatiblePlugins'],
    tier: migrations === 0 ? 'none' : db.dialect === 'sqlite' ? 'sqlite' : 'external-backup',
  }
}
export class MigrationError extends ManagerError {
  readonly detail: { kind: string; message: string }
  readonly backup: string | null
  readonly core: string[]
  readonly plugins: MigrationResult['plugins']
  constructor(
    detail: { kind: string; message: string },
    backup: string | null = null,
    core: string[] = [],
    plugins: MigrationResult['plugins'] = [],
  ) {
    super(detail.message)
    this.detail = detail
    this.backup = backup
    this.core = core
    this.plugins = plugins
  }
}
export function parseMigration(command: CommandResult): MigrationResult {
  let body: unknown
  try {
    body = JSON.parse(command.stdout)
  } catch {
    throw new ManagerError('迁移结果不完整，无法确认数据库状态')
  }
  if (
    object(body) &&
    object(body.error) &&
    typeof body.error.kind === 'string' &&
    typeof body.error.message === 'string'
  )
    throw new MigrationError(
      { kind: body.error.kind, message: body.error.message },
      typeof body.backup === 'string' && isAbsolute(body.backup) ? body.backup : null,
      strings(body.core) ? body.core : [],
      pluginMigrations(body.plugins) ? body.plugins : [],
    )
  if (command.code !== 0) throw new ManagerError('迁移失败，无法确认数据库状态')
  if (
    !object(body) ||
    !strings(body.core) ||
    !pluginMigrations(body.plugins) ||
    !(body.backup === null || (typeof body.backup === 'string' && isAbsolute(body.backup)))
  )
    throw new ManagerError('迁移结果不完整，无法确认数据库状态')
  return { core: body.core, plugins: body.plugins, backup: body.backup }
}
