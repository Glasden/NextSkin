// 导入引擎（ADR-0031）：安装向导、后台和命令行共用。每次运行从旧库重新导入全部数据：旧库在一个只读快照里单遍读，
// 目标库在一个事务里先清空、再写入；有停止类问题、出错、被取消，或者是试跑，就整体回滚
import { randomUUID } from 'node:crypto'
import { access, constants, stat } from 'node:fs/promises'
import {
  captureAutoIncrement,
  insertReturningId,
  readSnapshot,
  restoreAutoIncrement,
  syncAutoIncrement,
  toIsoTimestamp,
  type CoreDatabase,
  type ImportRunEntry,
  type ImportRunStatus,
} from '@nextskin/db'
import type { ImagePool, ImportableTextureStorage } from '@nextskin/domain/importer'
import { sql, type Kysely } from 'kysely'
import {
  ImportCancelledError,
  type ImportProgress,
  type ImportStage,
  type PlayerUuid,
  type StageContext,
} from './context.ts'
import { addBlocking, cappedList, tableStats, type ImportReport } from './report.ts'
import { planSettings } from './settings.ts'
import { importCloset } from './stages/closet.ts'
import { importOAuthClients } from './stages/oauth-clients.ts'
import { importPlayers, parseUuidOverrides } from './stages/players.ts'
import { importReports } from './stages/reports.ts'
import { siteLocale, writeSettings } from './stages/settings.ts'
import { finishTextureFiles, importTextures, recountLikes } from './stages/textures.ts'
import { fillAvatars, importUsers, passwordFormat } from './stages/users.ts'
import { describeConnection, snapshotSource, type SourceConnection } from './source/connection.ts'
import { inspectSourceSchema, type SourceDatabase } from './source/schema.ts'
import {
  AUTO_INCREMENT_TABLES,
  clearBusinessData,
  IMPORT_SCORE_REASON,
  importWatermark,
  inspectTarget,
  targetIssue,
} from './target.ts'
import { isTimeZone, toText } from './values.ts'

export interface ImportOptions {
  /** 目标库，已经迁移到最新 */
  db: Kysely<CoreDatabase>
  source: SourceConnection
  /** 旧站 .env 的 DB_PREFIX */
  prefix: string
  /** 旧站的材质目录，NextSkin 进程要能读 */
  texturesDirectory: string
  /** 旧站 config/app.php 的时区，BS 的时间按它解释；同时写进 site.timeZone */
  timeZone: string
  /** 旧站 .env 的 PWD_METHOD；没有 .env 时为 null，按 BS 的默认 BCRYPT */
  passwordMethod: string | null
  /** 旧站 .env 的 SALT。只在内存里，存进加密的设置项 */
  salt: string
  /** 覆盖导入的 site_url：迁移时常常换了域名或端口 */
  siteUrl?: string | null
  /** 逐个指定角色的 UUID：{ "<pid>": "<uuid>" } */
  uuidOverrides?: Readonly<Record<string, string>>
  /** 完整跑一遍、生成报告，最后回滚，不复制文件 */
  dryRun: boolean
  /** 目标库有上一次导入的数据时也写 */
  replace: boolean
  /** 上一次导入之后新站产生了数据，或者有数据却从没导入过时也写（还要 replace） */
  force: boolean
  entry: ImportRunEntry
  /** 发起人的邮箱，命令行为空 */
  startedBy?: string | null
  storage: ImportableTextureStorage
  imagePool: ImagePool
  /** 加密机密设置（签名私钥、盐）的 NEXTSKIN_SECRET */
  secretKey: string
  signal?: AbortSignal
  onProgress?: (progress: ImportProgress) => void
  /**
   * 每个导入的角色的 UUID 和来源（报告里只有统计和一部分）。试跑和被回滚的运行也会调用。
   * 生成的 UUID 后来因为冲突改成随机 UUID 的角色会再报告一次，以后一次为准
   */
  onPlayerUuid?: (entry: PlayerUuid) => void
  now?: () => Date
}

export interface ImportResult {
  runId: number
  status: ImportRunStatus
  report: ImportReport
}

/** 参数不对、材质目录读不了：还没开始运行，import_runs 里也没有记录 */
export class ImportOptionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportOptionsError'
  }
}

class Rollback extends Error {}

export async function checkImportOptions(
  options: Pick<ImportOptions, 'timeZone' | 'passwordMethod' | 'texturesDirectory' | 'siteUrl'>,
): Promise<void> {
  if (!isTimeZone(options.timeZone))
    throw new ImportOptionsError(`时区 ${options.timeZone} 不认识；请使用 IANA 时区名，例如 Asia/Shanghai`)
  try {
    passwordFormat(options.passwordMethod)
  } catch (error) {
    throw new ImportOptionsError(error instanceof Error ? error.message : '不支持这个 PWD_METHOD')
  }
  if (options.siteUrl) {
    let url: URL | null = null
    try {
      url = new URL(options.siteUrl)
    } catch {
      // 下面统一报错
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:'))
      throw new ImportOptionsError('站点地址要以 http:// 或 https:// 开头')
  }
  try {
    if (!(await stat(options.texturesDirectory)).isDirectory()) throw new Error()
    await access(options.texturesDirectory, constants.R_OK | constants.X_OK)
  } catch {
    throw new ImportOptionsError(
      `材质目录 ${options.texturesDirectory} 不存在或读不了；NextSkin 进程要能直接读到旧站的材质目录`,
    )
  }
}

function emptyReport(options: ImportOptions, startedAt: string): ImportReport {
  return {
    version: 1,
    dryRun: options.dryRun,
    startedAt,
    finishedAt: startedAt,
    error: null,
    source: {
      ...describeConnection(options.source),
      prefix: options.prefix,
      texturesDirectory: options.texturesDirectory,
      timeZone: options.timeZone,
      passwordMethod: options.passwordMethod ?? 'BCRYPT',
      bsVersion: null,
      uuidTable: 'none',
    },
    blocking: cappedList(),
    uuid: {
      counts: { pid: 0, name: 0, override: 0, offline: 0, random: 0 },
      generated: cappedList(),
      nameMismatches: cappedList(),
      orphanMappings: 0,
    },
    tables: {
      users: tableStats(),
      players: tableStats(),
      textures: tableStats(),
      closet: tableStats(),
      reports: tableStats(),
      oauthClients: tableStats(),
    },
    files: {
      total: 0,
      decoded: 0,
      reused: 0,
      copied: 0,
      alreadyStored: 0,
      missing: cappedList(),
      undecodable: cappedList(),
      nonconforming: cappedList(),
    },
    settings: { imported: [], clamped: [], invalid: [], notImported: [], otherLocales: [], rawHtml: [] },
    closet: { duplicates: 0 },
    reports: { duplicates: 0, autoResolved: 0, refunded: 0 },
    likes: cappedList(),
    unknownTables: [],
    verification: { checked: 0, mismatches: cappedList() },
    target: { before: { users: 0, players: 0, textures: 0 }, lastImportAt: null, newData: null },
    watermark: null,
  }
}

export async function runImport(options: ImportOptions): Promise<ImportResult> {
  await checkImportOptions(options)
  const now = options.now ?? (() => new Date())
  const startedAt = toIsoTimestamp(now())
  const report = emptyReport(options, startedAt)
  const description = describeConnection(options.source)
  const runId = await insertReturningId(options.db, 'import_runs', {
    status: 'running',
    is_dry_run: options.dryRun ? 1 : 0,
    entry: options.entry,
    started_by: options.startedBy ?? null,
    // 机密（数据库密码、盐）不写进来
    source: JSON.stringify({
      ...description,
      prefix: options.prefix,
      texturesDirectory: options.texturesDirectory,
      timeZone: options.timeZone,
    }),
    started_at: startedAt,
  })
  let status: ImportRunStatus = 'failed'
  try {
    status = await execute(options, report, startedAt)
  } catch (error) {
    status = error instanceof ImportCancelledError ? 'cancelled' : 'failed'
    report.error = error instanceof Error ? error.message : '导入失败'
  } finally {
    const finishedAt = toIsoTimestamp(now())
    report.finishedAt = finishedAt
    await options.db
      .updateTable('import_runs')
      .set({ status, report: JSON.stringify(report), finished_at: finishedAt })
      .where('id', '=', runId)
      .execute()
  }
  return { runId, status, report }
}

async function execute(
  options: ImportOptions,
  report: ImportReport,
  now: ReturnType<typeof toIsoTimestamp>,
): Promise<ImportRunStatus> {
  const progress = { stage: 'connect' as ImportStage, rows: 0, files: 0 }
  const advance = (stage: ImportStage, rows: number, files?: number) => {
    if (options.signal?.aborted) throw new ImportCancelledError()
    if (stage !== progress.stage) {
      progress.stage = stage
      progress.rows = 0
    }
    progress.rows += rows
    if (files !== undefined) progress.files = files
    options.onProgress?.({ ...progress })
    // 回调里取消的（例如进度页上的按钮），在下一次写入之前就要生效，提交之前的最后一次也一样
    if (options.signal?.aborted) throw new ImportCancelledError()
  }
  advance('connect', 0)
  const format = passwordFormat(options.passwordMethod)
  const claim = randomUUID()
  // MySQL 的自增计数器不随事务回滚：显式写入旧站的 id 之后，回滚了也要恢复
  const counters = await captureAutoIncrement(options.db, AUTO_INCREMENT_TABLES)
  let committed = false
  try {
    await readSnapshot<SourceDatabase, void>(snapshotSource(options.source), async (src) => {
      const schema = await inspectSourceSchema(src, options.prefix)
      report.unknownTables = schema.unknown
      report.source.uuidTable = schema.uuid ? (schema.uuid.hasPid ? 'yggdrasil-connect' : 'yggdrasil-api') : 'none'
      const bsOptions = new Map<string, string>()
      for (const row of (await src
        .selectFrom(schema.tables.options)
        .select(['option_name', 'option_value'] as never)
        .orderBy('id')
        .execute()) as Record<string, unknown>[]) {
        const name = toText(row.option_name)
        if (name !== null) bsOptions.set(name, toText(row.option_value) ?? '')
      }
      report.source.bsVersion = bsOptions.get('version') || null
      await checkIdRanges(src, schema.tables, report)

      await options.db.transaction().execute(async (tx) => {
        const target = await inspectTarget(tx)
        report.target = { before: target.counts, lastImportAt: target.lastImportAt, newData: target.newData }
        const blocked = targetIssue(target, options)
        // 试跑不写，不受限制，但报告里照样写明真正导入时要加的参数
        if (blocked) {
          addBlocking(report, blocked)
          if (!options.dryRun) throw new Rollback()
        }
        const plan = planSettings({
          options: bsOptions,
          timeZone: options.timeZone,
          siteUrl: options.siteUrl ?? null,
          salt: options.salt,
          siteLocale: await siteLocale(tx),
        })
        report.settings = plan.report
        for (const issue of plan.issues) addBlocking(report, issue)
        const ctx: StageContext = {
          src,
          tx,
          schema,
          report,
          rules: plan.rules,
          timeZone: options.timeZone,
          now,
          advance,
          onPlayerUuid: options.onPlayerUuid,
        }
        const overrides = parseUuidOverrides(options.uuidOverrides ?? {}, ctx)

        await clearBusinessData(tx)
        await importUsers(ctx, format)
        await importTextures(ctx, {
          texturesDirectory: options.texturesDirectory,
          storage: options.storage,
          imagePool: options.imagePool,
          dryRun: options.dryRun,
          claim,
        })
        await fillAvatars(ctx)
        await importPlayers(ctx, overrides)
        await importCloset(ctx)
        await recountLikes(ctx)
        await importReports(ctx)
        // 积分不为 0 的用户另写一条"导入"流水，余额等于导入的积分（docs/schema.md）
        await tx
          .insertInto('score_transactions')
          .columns(['user_id', 'delta', 'balance', 'reason', 'created_at'])
          .expression((eb) =>
            eb
              .selectFrom('users')
              .select([
                'id',
                'score',
                sql<number>`score`.as('balance'),
                sql<string>`${IMPORT_SCORE_REASON}`.as('reason'),
                sql<string>`${now}`.as('created_at'),
              ])
              .where('score', '!=', 0),
          )
          .execute()
        await importOAuthClients(ctx)
        await writeSettings(ctx, plan, options.secretKey)
        await finishTextureFiles(tx, claim)
        if (report.verification.mismatches.total)
          addBlocking(report, { code: 'verification_failed', mismatches: report.verification.mismatches.total })
        if (report.blocking.total || options.dryRun) throw new Rollback()
        // PostgreSQL 的 setval 不随事务回滚，确定要提交了才同步
        for (const table of ['users', 'textures', 'players', 'reports'] as const) await syncAutoIncrement(tx, table)
        report.watermark = await importWatermark(tx)
        advance('commit', 0)
      })
      committed = true
    })
  } catch (error) {
    // 目标库已经提交时，之后的错误（例如关旧库的连接）不改变结果
    if (!committed && !(error instanceof Rollback)) throw error
  } finally {
    // 恢复失败只会在编号里留下空洞，不掩盖本来的结果
    if (!committed) await restoreAutoIncrement(options.db, counters).catch(() => {})
  }
  return report.blocking.total ? 'blocked' : 'succeeded'
}

/** 开始前检查各表 id 的最大值，超过 2147483647 时停止（ADR-0015）；超出的行在各阶段跳过，以便收集其余问题 */
async function checkIdRanges(
  src: Kysely<SourceDatabase>,
  tables: { users: string; players: string; textures: string; reports: string },
  report: ImportReport,
): Promise<void> {
  for (const [table, column] of [
    [tables.users, 'uid'],
    [tables.players, 'pid'],
    [tables.textures, 'tid'],
    [tables.reports, 'id'],
  ] as const) {
    const row = (await src
      .selectFrom(table)
      .select((eb) => eb.fn.max(column as never).as('max'))
      .executeTakeFirst()) as { max: unknown } | undefined
    const max = Number(row?.max ?? 0)
    if (max > 2147483647) addBlocking(report, { code: 'id_out_of_range', table, maxId: max })
  }
}
