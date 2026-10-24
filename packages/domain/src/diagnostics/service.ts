import { statfs } from 'node:fs/promises'
import { arch, release, type } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import {
  coreMigrations,
  databaseServerVersion,
  dialectOf,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type IsoTimestamp,
} from '@nextskin/db'
import { LOG_FILE_DROPPED, LOG_IPC_DROPPED, parseLogRecord } from '@nextskin/logging'
import { PLUGIN_API_VERSION } from '@nextskin/plugin-host'
import { strToU8, zipSync } from 'fflate'
import type { Kysely } from 'kysely'
import { authorize } from '../admin/context.ts'
import type { AdminActor } from '../admin/types.ts'
import { audit } from '../audit/write.ts'
import { jobStatistics, jobSummary } from '../jobs/store.ts'
import type { PluginSystem } from '../plugins/system.ts'
import { coreSettingsNamespace, coreSettingsRegistry, type CoreSettingKey } from '../settings/registry.ts'
import { storedValue } from '../settings/write.ts'
import type { createUpdates } from '../updates/service.ts'
import { EXPORT_LOG_BYTES, exportLogs, logStorage, readLogs, type DiagnosticsLogQuery } from './logs.ts'
import { createDiagnosticsRedactor } from './redact.ts'
import type { DiagnosticsRuntime, DiagnosticsSummary } from './types.ts'

const README = `NextSkin 诊断包
包含健康摘要、全部设置、环境变量名称、插件和任务状态、最近最多 10 MB 的日志。
机密设置只记是否设置；其他字符串先清除常见机密，再将邮箱和公网 IP 按包内一致的编号替换。内网、回环和链路本地 IP 保留；实例目录、外部数据目录和用户主目录会替换。角色名、UUID、材质 hash 和 uid 保留。脱敏是尽力而为，发出去之前自己看一遍。

NextSkin diagnostics bundle
Contains the health summary, all settings, environment variable names, plugin and job status, and up to 10 MB of recent logs.
Secret settings contain only whether they are set. Other strings have common secrets removed, then emails and public IPs replaced with consistent identifiers. Private, loopback and link-local IPs remain. Instance, external data and home directories are replaced. Player names, UUIDs, texture hashes and uids remain. Redaction is best effort: review the bundle yourself before sharing it.
`

export function createDiagnostics(
  options: DiagnosticsRuntime & {
    db: Kysely<CoreDatabase>
    dataDirectory: string
    secretKey: string
    startedAt: IsoTimestamp
    now: () => Date
    version?: string
    plugins: Pick<PluginSystem, 'hostStatus' | 'pendingMigrations' | 'get' | 'isRunning'>
    updates: Pick<ReturnType<typeof createUpdates>, 'status'>
  },
) {
  const { db, plugins, now } = options
  const authorizeRead = (actor: AdminActor) =>
    transactionWithRetry(db, (tx) => authorize(tx, actor, 'diagnostics.read'))
  async function summary(actor: AdminActor): Promise<DiagnosticsSummary> {
    await authorizeRead(actor)
    const at = now()
    const [serverVersion, migrations, pendingPlugins, storage, disk, jobs, update] = await Promise.all([
      databaseServerVersion(db).catch(() => null),
      db
        .withTables<{ nextskin_migration: { name: string } }>()
        .selectFrom('nextskin_migration')
        .select('name')
        .execute(),
      plugins.pendingMigrations(),
      logStorage(options.dataDirectory),
      statfs(options.dataDirectory).catch(() => null),
      jobSummary(db, toIsoTimestamp(at)),
      options.updates.status(actor),
    ])
    const known = new Set(Object.keys(coreMigrations)),
      done = new Set(migrations.map((row) => row.name))
    // 从新往旧最多扫 8 MB：扫到 24 小时以前的记录或者文件的开头才算数全了，否则页面写"至少"
    let dropped = 0
    let reachedCutoff = false
    let droppedComplete = true
    if (storage.logFiles) {
      const scan = await readLogs(options.dataDirectory, {}, (entry) => {
        const record = entry.record
        if (record && Date.parse(record.time) < at.getTime() - 86_400_000) reachedCutoff = true
        if (!record || (record.msg !== LOG_FILE_DROPPED && record.msg !== LOG_IPC_DROPPED)) return
        const time = Date.parse(record.time)
        if (
          time >= at.getTime() - 86_400_000 &&
          time <= at.getTime() &&
          typeof record.dropped === 'number' &&
          Number.isSafeInteger(record.dropped) &&
          record.dropped >= 0
        )
          dropped += record.dropped
      })
      droppedComplete = reachedCutoff || scan.next === null
    }
    return {
      versions: {
        nextskin: options.version ?? null,
        pluginApi: PLUGIN_API_VERSION,
        node: process.version,
        os: `${type()} ${release()}`,
        arch: arch(),
      },
      runMode: options.runMode,
      generatedAt: toIsoTimestamp(at),
      startedAt: options.startedAt,
      database: {
        dialect: dialectOf(db),
        serverVersion,
        pendingCore: [...known].filter((name) => !done.has(name)).length,
        unknownCore: [...done].filter((name) => !known.has(name)).length,
        pendingPlugins: pendingPlugins.map(({ plugin, migrations }) => ({ plugin, migrations: migrations.length })),
      },
      storage: {
        dataDirectory: options.dataDirectory,
        freeBytes: disk ? disk.bavail * disk.bsize : null,
        totalBytes: disk ? disk.blocks * disk.bsize : null,
        fileLogging: options.fileLogging,
        ...storage,
        droppedRecently: storage.logFiles ? dropped : null,
        droppedComplete,
      },
      pluginHost: plugins.hostStatus(),
      jobs,
      lastUpdate: update.manager.available ? update.manager.lastResult : null,
    }
  }
  return {
    summary,
    async logs(actor: AdminActor, query: DiagnosticsLogQuery = {}) {
      await authorizeRead(actor)
      return readLogs(options.dataDirectory, query)
    },
    async export(actor: AdminActor): Promise<{ filename: string; body: Uint8Array }> {
      await authorizeRead(actor)
      const redactor = createDiagnosticsRedactor(options)
      const files: Record<string, Uint8Array> = { 'README.txt': strToU8(README) }
      const json = (name: string, value: unknown) => {
        files[name] = strToU8(JSON.stringify(redactor.value(value), null, 2) + '\n')
      }
      json('summary.json', await summary(actor))
      const rows = await db
        .selectFrom('settings')
        .select(['key', 'value'])
        .where('namespace', '=', coreSettingsNamespace)
        .execute()
      const settings: Record<string, unknown> = {}
      for (const key of Object.keys(coreSettingsRegistry) as CoreSettingKey[]) {
        const definition = coreSettingsRegistry[key]
        const { value } = storedValue(key, rows.find((row) => row.key === key)?.value, options.secretKey)
        settings[key] = definition.secret ? { isSet: !isDeepStrictEqual(value, definition.default) } : value
      }
      json('settings.json', settings)
      json('env.json', { names: options.envNames, database: { dialect: dialectOf(db) } })
      const installed = await db
        .selectFrom('plugins')
        .select(['id', 'version', 'is_enabled', 'last_error'])
        .orderBy('id')
        .execute()
      json(
        'plugins.json',
        installed.map((row) => {
          const known = plugins.get(row.id)
          // 自由文本不进插件清单；只接受现有 last_error 的开头错误码。
          const code = row.last_error?.match(/^([a-z][a-z0-9_]*)(?=:|$)/u)?.[1] ?? null
          return {
            id: row.id,
            version: known?.official ? known.manifest.version : row.version,
            enabled: row.is_enabled === 1,
            running: plugins.isRunning(row.id),
            packageMissing: !known || (!known.official && !known.local),
            lastError: code,
          }
        }),
      )
      json('jobs.json', await jobStatistics(db))
      // 结构化的行先拆开、逐个值脱敏，字符串里嵌着的 JSON（"{\"token\":…}"）才认得出来；
      // 再整行过一遍，按字段名兜底（"password":"…"）
      const redactLine = (line: string) => {
        const record = parseLogRecord(line)
        return redactor.text(record ? JSON.stringify(redactor.value(record)) : line)
      }
      let logBytes = 0
      let full = false
      for (const log of await exportLogs(options.dataDirectory)) {
        if (full) break
        const lines = log.bytes.toString('utf8').split('\n')
        const redacted: string[] = []
        // 脱敏后的字节数也受 10 MB 限制；按最新的完整行保留，编号在整个包内共用。
        for (let index = lines.length - 2; index >= 0; index--) {
          const line = redactLine(lines[index]!) + '\n'
          const bytes = Buffer.byteLength(line)
          // 装不下这一行就停：更旧的行即使更短也不要，免得包里的日志中间断一截
          if (logBytes + bytes > EXPORT_LOG_BYTES) {
            full = true
            break
          }
          redacted.push(line)
          logBytes += bytes
        }
        if (redacted.length) files[`logs/${log.name}`] = strToU8(redacted.reverse().join(''))
      }
      const body = zipSync(files)
      await transactionWithRetry(db, async (tx) => {
        const authorized = await authorize(tx, actor, 'diagnostics.read')
        await audit(tx, {
          actor: authorized,
          action: 'diagnostics.export',
          subject: { type: 'diagnostics', id: 0 },
          details: { logBytes },
          ip: actor.ip,
          now: toIsoTimestamp(now()),
        })
      })
      const stamp = now()
        .toISOString()
        .replace(/[-:]/gu, '')
        .replace(/\.\d{3}Z$/u, 'Z')
      return { filename: `nextskin-diagnostics-${stamp}.zip`, body }
    },
  }
}
