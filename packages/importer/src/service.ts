import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { access, constants, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  countRows,
  createDatabase,
  readSnapshot,
  type DatabaseConfig,
  type CoreDatabase,
  type ImportRunEntry,
  type ImportRunStatus,
  type ImportRunsTable,
} from '@nextskin/db'
import { createImagePool, createLocalTextureStorage, DomainError, type ImagePool } from '@nextskin/domain/importer'
import type { Selectable } from 'kysely'
import type { ImportProgress } from './context.ts'
import { checkImportOptions, ImportOptionsError, runImport } from './engine.ts'
import { reportToMarkdown } from './markdown.ts'
import type { ImportReport } from './report.ts'
import {
  describeConnection,
  snapshotSource,
  type SourceConnection,
  type SourceDescription,
} from './source/connection.ts'
import { parseDotenv, readBsEnvironment, type BsEnvironment } from './source/env.ts'
import { inspectSourceSchema, SourceSchemaError, type SourceDatabase } from './source/schema.ts'
import { passwordFormat } from './stages/users.ts'
import { failInterruptedRuns } from './target.ts'
import { isTimeZone, toText } from './values.ts'

export interface ImportServiceOptions {
  database: DatabaseConfig
  textureDirectory: string
  secretKey: string
  maintenance: { enter(): Promise<void>; exit(): Promise<void> }
  onImported?: () => Promise<void> | void
  createImagePool?: () => ImagePool
  now?: () => Date
}
export type ImportEnvForm = BsEnvironment
export interface ImportSourceInput {
  connection: SourceConnection
  prefix: string
  texturesDirectory: string
  timeZone: string
  passwordMethod: string | null
  salt: string
}
export interface ImportCheckResult {
  database:
    | {
        status: 'ok'
        bsVersion: string | null
        counts: { users: number; players: number; textures: number }
        uuidTable: 'yggdrasil-api' | 'yggdrasil-connect' | null
        descriptions: boolean
        unknownTables: { name: string; rows: number }[]
      }
    | {
        status: 'unreachable' | 'auth_failed' | 'database_missing' | 'not_blessing_skin' | 'failed'
        detail: string | null
      }
  textures: { readable: boolean; sampled: number; missing: number }
}
export interface ImportStartInput extends ImportSourceInput {
  dryRun: boolean
  siteUrl: string | null
  uuidOverrides: Record<string, string>
  replace: boolean
  force: boolean
}
export interface ImportRunState {
  id: number | null
  entry: ImportRunEntry
  dryRun: boolean
  status: ImportRunStatus
  cancelling: boolean
  progress: ImportProgress
  startedAt: string
  finishedAt: string | null
  report: ImportReport | null
}
export interface ImportSourceDefaults {
  connection: SourceDescription
  prefix: string
  texturesDirectory: string
  timeZone: string
}
export interface ImportRunSummary {
  id: number
  status: ImportRunStatus
  dryRun: boolean
  entry: ImportRunEntry
  startedBy: string | null
  startedAt: string
  finishedAt: string | null
  source: ImportSourceDefaults
  totals: { users: number; players: number; textures: number; blocking: number } | null
  error: string | null
}
export interface ImportService {
  maintenance(): boolean
  parseEnv(text: string, directory: string | null): ImportEnvForm
  check(input: ImportSourceInput): Promise<ImportCheckResult>
  start(
    input: ImportStartInput,
    meta: { entry: 'setup' | 'admin'; startedBy: string | null },
  ): Promise<{ token: string; state: ImportRunState }>
  run(token: string): ImportRunState | null
  cancel(token: string): ImportRunState | null
  runMarkdown(token: string): string | null
  listRuns(page: number, perPage: number): Promise<{ runs: ImportRunSummary[]; total: number }>
  getRun(id: number): Promise<{ run: ImportRunSummary; report: ImportReport | null } | null>
  runMarkdownById(id: number): Promise<string | null>
  lastSource(): Promise<ImportSourceDefaults | null>
  close(): Promise<void>
}

function assertPaths(input: ImportSourceInput) {
  if (input.connection.dialect === 'sqlite' && !isAbsolute(input.connection.file))
    throw new DomainError('invalid_request', undefined, ['connection'])
  if (!isAbsolute(input.texturesDirectory)) throw new DomainError('invalid_request', undefined, ['texturesDirectory'])
}
async function readableDirectory(directory: string): Promise<boolean> {
  try {
    if (!(await stat(directory)).isDirectory()) return false
    await access(directory, constants.R_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}
function databaseFailure(error: unknown): ImportCheckResult['database'] {
  if (error instanceof SourceSchemaError)
    return { status: 'not_blessing_skin', detail: error.table + (error.column ? `.${error.column}` : '') }
  const codes =
    typeof error === 'object' && error !== null
      ? ['code', 'errno', 'sqlState'].map((key) => String(Reflect.get(error, key)))
      : []
  if (codes.some((code) => ['1045', '28P01', '28000'].includes(code))) return { status: 'auth_failed', detail: null }
  if (codes.some((code) => ['1049', '3D000'].includes(code))) return { status: 'database_missing', detail: null }
  if (
    codes.some((code) =>
      [
        'ECONNREFUSED',
        'ENOTFOUND',
        'ETIMEDOUT',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'ECONNRESET',
        'EAI_AGAIN',
        'EADDRNOTAVAIL',
        'ECONNABORTED',
        'ENETDOWN',
        'EPIPE',
        'PROTOCOL_CONNECTION_LOST',
        'SQLITE_CANTOPEN',
        'ENOENT',
        'EACCES',
        'EPERM',
      ].includes(code),
    )
  )
    return { status: 'unreachable', detail: null }
  // readSnapshot 已将 SQLite 打开错误换成这条固定消息，不暴露底层路径。
  if (error instanceof Error && error.message === '打开 SQLite 数据库文件失败；请确认文件存在、进程有读权限')
    return { status: 'unreachable', detail: null }
  return { status: 'failed', detail: null }
}
function parseReport(text: string | null): ImportReport | null {
  try {
    const value = JSON.parse(text ?? 'null') as ImportReport | null
    return value?.version === 1 &&
      value.tables?.users &&
      value.tables.players &&
      value.tables.textures &&
      value.blocking
      ? value
      : null
  } catch {
    return null
  }
}
function sourceDefaults(text: string): ImportSourceDefaults {
  const source = JSON.parse(text) as SourceDescription & Omit<ImportSourceDefaults, 'connection'>
  return {
    connection: describeConnection(source as SourceConnection),
    prefix: source.prefix,
    texturesDirectory: source.texturesDirectory,
    timeZone: source.timeZone,
  }
}
function summary(row: Selectable<ImportRunsTable>, report = parseReport(row.report)): ImportRunSummary {
  return {
    id: row.id,
    status: row.status,
    dryRun: row.is_dry_run === 1,
    entry: row.entry,
    startedBy: row.started_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    source: sourceDefaults(row.source),
    totals: report
      ? {
          users: report.tables.users.imported,
          players: report.tables.players.imported,
          textures: report.tables.textures.imported,
          blocking: report.blocking.total,
        }
      : null,
    error: report?.error ?? null,
  }
}
const digest = (token: string) => createHash('sha256').update(token).digest()
function logError(error: unknown) {
  console.warn(`[import] ${error instanceof Error ? error.name : 'Error'}`)
}

export async function createImportService(options: ImportServiceOptions): Promise<ImportService> {
  const db = createDatabase<CoreDatabase>(options.database)
  const now = options.now ?? (() => new Date())
  try {
    await failInterruptedRuns(db, now())
  } catch (error) {
    await db.destroy()
    throw error
  }
  let maintenance = false
  let starting = false
  let closed = false
  let state: ImportRunState | null = null
  let tokenHash: Buffer | null = null
  let controller: AbortController | null = null
  let task: Promise<void> | null = null
  let startTask: Promise<void> | null = null
  const snapshot = () => structuredClone(state!)
  const valid = (token: string) => tokenHash !== null && timingSafeEqual(tokenHash, digest(token))
  const requireAvailable = () => {
    if (maintenance || starting) throw new DomainError('maintenance')
  }

  async function start(input: ImportStartInput, meta: { entry: 'setup' | 'admin'; startedBy: string | null }) {
    if (closed) throw new DomainError('maintenance')
    if (starting || maintenance) throw new DomainError('import_running')
    starting = true
    try {
      assertPaths(input)
      try {
        await checkImportOptions(input)
      } catch (error) {
        if (error instanceof ImportOptionsError) throw new DomainError(`import_${error.code}`, undefined, [error.field])
        throw error
      }
      const token = randomBytes(32).toString('base64url')
      maintenance = true
      try {
        await options.maintenance.enter()
      } catch (error) {
        try {
          await options.maintenance.exit()
        } catch (exitError) {
          logError(exitError)
        }
        maintenance = false
        throw error
      }
      tokenHash = digest(token)
      controller = new AbortController()
      state = {
        id: null,
        entry: meta.entry,
        dryRun: input.dryRun,
        status: 'running',
        cancelling: false,
        progress: { stage: 'connect', rows: 0, files: 0, total: null },
        startedAt: now().toISOString(),
        finishedAt: null,
        report: null,
      }
      const initial = snapshot()
      const current = state
      const signal = controller.signal
      task = (async () => {
        let pool: ImagePool | undefined
        let result: Awaited<ReturnType<typeof runImport>> | null = null
        try {
          pool = (options.createImagePool ?? createImagePool)()
          result = await runImport({
            ...input,
            ...meta,
            source: input.connection,
            db,
            storage: createLocalTextureStorage(options.textureDirectory),
            imagePool: pool,
            secretKey: options.secretKey,
            signal,
            now,
            onRunCreated: (id) => {
              current.id = id
            },
            onProgress: (progress) => {
              current.progress = progress
            },
          })
        } catch (error) {
          logError(error)
        } finally {
          try {
            await pool?.close()
          } catch (error) {
            logError(error)
          }
          try {
            await options.maintenance.exit()
          } catch (error) {
            logError(error)
            console.warn('[import] 后台任务可能仍处于暂停状态，请重启服务')
          }
          if (result?.status === 'succeeded' && !input.dryRun) {
            try {
              await options.onImported?.()
            } catch (error) {
              logError(error)
            }
          }
          // 收尾都做完了才公布结果：网页看到结束就会跳走，这时维护模式必须已经退出、任务已经恢复
          current.status = result?.status ?? 'failed'
          current.report = result?.report ?? null
          current.finishedAt = now().toISOString()
          maintenance = false
        }
      })()
      return { token, state: initial }
    } finally {
      starting = false
    }
  }
  const service: ImportService = {
    maintenance: () => maintenance,
    parseEnv: (text, directory) =>
      readBsEnvironment(parseDotenv(text), directory && isAbsolute(directory) ? directory : null),
    async check(input) {
      if (!isTimeZone(input.timeZone)) throw new DomainError('import_timezone_invalid')
      try {
        passwordFormat(input.passwordMethod)
      } catch {
        throw new DomainError('import_password_method_invalid')
      }
      assertPaths(input)
      let hashes: string[] = []
      let database: ImportCheckResult['database']
      try {
        database = await readSnapshot<SourceDatabase, ImportCheckResult['database']>(
          snapshotSource(input.connection),
          async (src) => {
            const schema = await inspectSourceSchema(src, input.prefix)
            const version = await src
              .selectFrom(schema.tables.options)
              .select('option_value')
              .where('option_name', '=', 'version')
              .executeTakeFirst()
            const rows = await src.selectFrom(schema.tables.textures).select('hash').orderBy('tid').limit(5).execute()
            hashes = rows
              .map((row) => toText(row.hash))
              .filter((hash): hash is string => hash !== null && /^[a-f0-9]{64}$/i.test(hash))
            return {
              status: 'ok',
              bsVersion: toText(version?.option_value),
              counts: {
                users: await countRows(src.selectFrom(schema.tables.users)),
                players: await countRows(src.selectFrom(schema.tables.players)),
                textures: await countRows(src.selectFrom(schema.tables.textures)),
              },
              uuidTable: schema.uuid ? (schema.uuid.hasPid ? 'yggdrasil-connect' : 'yggdrasil-api') : null,
              descriptions: schema.descriptions !== null,
              unknownTables: schema.unknown,
            }
          },
        )
      } catch (error) {
        database = databaseFailure(error)
      }
      const readable = await readableDirectory(input.texturesDirectory)
      let missing = 0
      if (readable)
        for (const hash of hashes) {
          try {
            await access(join(input.texturesDirectory, hash), constants.R_OK)
          } catch {
            missing++
          }
        }
      return { database, textures: { readable, sampled: readable ? hashes.length : 0, missing } }
    },
    start(input, meta) {
      if (starting || maintenance) return Promise.reject(new DomainError('import_running'))
      const result = start(input, meta)
      // 等待启动只保留完成信号，不能把带运行令牌的返回值留在服务内存里。
      startTask = result.then(
        () => {},
        () => {},
      )
      return result
    },
    run(token) {
      return valid(token) && state ? snapshot() : null
    },
    cancel(token) {
      if (!valid(token) || !state) return null
      if (state.status !== 'running') throw new DomainError('import_not_running')
      state.cancelling = true
      controller!.abort()
      return snapshot()
    },
    runMarkdown(token) {
      return valid(token) && state?.finishedAt && state.report ? reportToMarkdown(state.report) : null
    },
    async listRuns(page, perPage) {
      requireAvailable()
      const rows = await db
        .selectFrom('import_runs')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(perPage)
        .offset((page - 1) * perPage)
        .execute()
      return { runs: rows.map((row) => summary(row)), total: await countRows(db.selectFrom('import_runs')) }
    },
    async getRun(id) {
      requireAvailable()
      const row = await db.selectFrom('import_runs').selectAll().where('id', '=', id).executeTakeFirst()
      if (!row) return null
      const report = parseReport(row.report)
      return { run: summary(row, report), report }
    },
    async runMarkdownById(id) {
      const result = await service.getRun(id)
      return result?.report ? reportToMarkdown(result.report) : null
    },
    async lastSource() {
      requireAvailable()
      const row = await db.selectFrom('import_runs').select('source').orderBy('id', 'desc').executeTakeFirst()
      return row ? sourceDefaults(row.source) : null
    },
    async close() {
      closed = true
      if (starting) await startTask?.catch(() => {})
      controller?.abort()
      await task
      await db.destroy()
    },
  }
  return service
}
