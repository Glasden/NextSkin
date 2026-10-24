import type { ReleaseEntry } from '@nextskin/updates'

export type Dialect = 'sqlite' | 'mysql' | 'mariadb' | 'postgres'
export interface UpgradeRecord {
  from: string
  migrations: boolean
  dialect: Dialect
  backup: string | null
}
export interface Current {
  schema: 1
  current: string
  previous: string | null
  bundled: string
  failed: string[]
  upgrades: Record<string, UpgradeRecord>
}
export interface MigrationResult {
  core: string[]
  plugins: { plugin: string; migrations: string[] }[]
  backup: string | null
}
export interface Preflight {
  version: string
  dataDirectory: string
  sqliteFile: string | null
  dialect: Dialect
  pendingCore: string[]
  pendingPlugins: MigrationResult['plugins']
  incompatiblePlugins: { id: string; api: string }[]
  tier: 'none' | 'sqlite' | 'external-backup'
}
export interface UpdateLog {
  at: string
  kind: 'update' | 'manual' | 'legacy' | 'rollback'
  from: string
  to: string
  result: 'success' | 'rolled-back' | 'failed'
  step: number
  reason?: string
  migrations?: boolean
  backup?: string | null
  error?: { kind: string; message: string }
}
export type UpgradeResult = UpdateLog
export interface InternalManagerStatus {
  current: string
  previous: string | null
  operation: {
    kind: 'check' | 'prepare' | 'apply' | 'rollback'
    version: string
    step: number
    startedAt: string
    progress?: { received: number; total: number }
  } | null
  prepared: Preflight | null
  lastResult: UpdateLog | null
}
export interface Manager {
  status(this: void): InternalManagerStatus
  check(this: void): Promise<ReleaseEntry[]>
  prepare(this: void, version: string): Promise<Preflight>
  prepareLocal(this: void, version: string, options?: { from?: string; legacy?: boolean }): Promise<Preflight>
  apply(this: void, version: string, options?: { backupConfirmed?: boolean }): Promise<UpgradeResult>
  rollback(this: void, options?: { confirmed?: boolean }): Promise<UpgradeResult>
  cancel(this: void): void
}

export class ConfigError extends Error {
  readonly exitCode = 78
}
export type ManagerErrorCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'busy'
  | 'readonly'
  | 'not_prepared'
  | 'not_newer'
  | 'unknown_version'
  | 'manager_outdated'
  | 'node_too_old'
  | 'backup_required'
  | 'offline_required'
  | 'confirmation_required'
  | 'no_previous'
  | 'backup_missing'
  | 'preflight_failed'
  | 'download_failed'
  | 'internal'
export const offlineRollbackMessage =
  'MySQL、PostgreSQL 有迁移时不能在线回滚：先停掉服务，用升级前的备份恢复数据库，再运行 node nextskin.mjs rollback --yes，然后启动服务'
export class ManagerError extends Error {
  readonly exitCode = 1
  readonly code: ManagerErrorCode
  constructor(message: string, code: ManagerErrorCode = 'internal') {
    super(message)
    this.code = code
  }
}

/** 交给核心和浏览器的状态只含业务信息，不能暴露本机路径。 */
export interface ManagerStatus {
  protocol: number
  pendingManager: string | null
  version: string
  current: string
  previous: string | null
  writable: boolean
  operation: null | {
    kind: 'prepare' | 'apply' | 'rollback'
    version: string | null
    step: string
    startedAt: string
    progress?: { received: number; total: number }
  }
  prepared: null | {
    version: string
    preflight: {
      dialect: 'sqlite' | 'mysql' | 'postgres'
      pendingCore: number
      pendingPlugins: number
      tier: 'none' | 'sqlite' | 'external-backup'
      incompatiblePlugins: { id: string; api: string }[]
    }
  }
  lastResult: null | {
    at: string
    kind: 'update' | 'manual' | 'legacy' | 'rollback'
    from: string | null
    to: string
    result: 'success' | 'rolled-back' | 'failed'
    step: string | null
    reason: string | null
  }
  failed: string[]
  rollback: null | {
    version: string
    migrations: boolean
    dialect: 'sqlite' | 'mysql' | 'postgres' | null
    backupAvailable: boolean
  }
}
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
export const dialect = (value: unknown): value is Dialect =>
  value === 'sqlite' || value === 'mysql' || value === 'mariadb' || value === 'postgres'

/** 子进程的约定消息可以保留；意外异常只报固定诊断，避免把连接串带进日志。 */
export function reason(error: unknown): string {
  return error instanceof ManagerError || error instanceof ConfigError
    ? error.message
    : '管理操作失败，请检查目录权限和发行目录'
}
