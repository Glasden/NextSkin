// 目标库：能不能写、清空业务数据（ADR-0031"每次运行整库替换"）
import { countRows, toIsoTimestamp, type CoreDatabase, type IsoTimestamp } from '@nextskin/db'
import { sql, type Kysely } from 'kysely'
import type { BlockingIssue, ImportWatermark, NewSiteData, TargetCounts } from './report.ts'

export const IMPORT_SCORE_REASON = 'score.reasons.import'

/** 导入清空的业务表，按删除的先后排好（外键）。texture_files 不在其中，见 clearBusinessData */
const BUSINESS_TABLES = [
  'device_code_selections',
  'yggdrasil_tokens',
  'closet_items',
  'reports',
  'score_transactions',
  'audit_logs',
  'jobs',
  'failed_jobs',
  'oauth_access_tokens',
  'oauth_refresh_tokens',
  'oauth_consents',
  'oauth_client_assertions',
  'oauth_client_resources',
  'device_codes',
  'verifications',
  'two_factors',
  'passkeys',
  'sessions',
  'accounts',
  'players',
  'textures',
  'oauth_clients',
  'users',
] as const

/** 导入时显式写入 id 或生成 id 的表：回滚之后要恢复 MySQL 的自增计数器 */
export const AUTO_INCREMENT_TABLES = [
  'users',
  'accounts',
  'textures',
  'players',
  'reports',
  'score_transactions',
  'oauth_clients',
] as const

/** 最近一次成功、不是试跑的导入 */
export async function lastImport(
  db: Kysely<CoreDatabase>,
): Promise<{ id: number; finishedAt: IsoTimestamp; watermark: ImportWatermark | null } | null> {
  const row = await db
    .selectFrom('import_runs')
    .select(['id', 'finished_at', 'report'])
    .where('status', '=', 'succeeded')
    .where('is_dry_run', '=', 0)
    .orderBy('id', 'desc')
    .executeTakeFirst()
  if (!row?.finished_at) return null
  let watermark: ImportWatermark | null = null
  try {
    watermark = (JSON.parse(row.report ?? 'null') as { watermark?: ImportWatermark } | null)?.watermark ?? null
  } catch {
    // 报告坏了：按导入的行全都可能是新站的数据处理，要 force
  }
  return { id: row.id, finishedAt: row.finished_at, watermark }
}

/** 站点未初始化：没有用户，也没有成功的导入（试跑不算）。安装向导只在这时可用 */
export async function isSiteInitialized(db: Kysely<CoreDatabase>): Promise<boolean> {
  if (await db.selectFrom('users').select('id').limit(1).executeTakeFirst()) return true
  return (await lastImport(db)) !== null
}

/** 服务或命令行启动时：上次中途退出的运行，数据库已经回滚了它的事务，记录标为失败 */
export async function failInterruptedRuns(db: Kysely<CoreDatabase>, now: Date): Promise<number> {
  const result = await db
    .updateTable('import_runs')
    .set({ status: 'failed', finished_at: toIsoTimestamp(now) })
    .where('status', '=', 'running')
    .executeTakeFirst()
  return Number(result.numUpdatedRows)
}

export interface TargetState {
  counts: TargetCounts
  /** 导入会清空的表里有任何一行 */
  hasData: boolean
  lastImportAt: IsoTimestamp | null
  newData: NewSiteData | null
}

/** 提交之前记下这次导入写进去的范围（ImportWatermark） */
export async function importWatermark(db: Kysely<CoreDatabase>): Promise<ImportWatermark> {
  const max = async (table: 'users' | 'players' | 'textures' | 'reports' | 'oauth_clients') =>
    Number(
      (
        await db
          .selectFrom(table)
          .select((eb) => eb.fn.max('id').as('max'))
          .executeTakeFirst()
      )?.max ?? 0,
    )
  const latest = async (table: 'players' | 'textures') =>
    (
      await db
        .selectFrom(table)
        .select((eb) => eb.fn.max('updated_at').as('max'))
        .executeTakeFirst()
    )?.max ?? null
  return {
    maxUserId: await max('users'),
    maxPlayerId: await max('players'),
    maxTextureId: await max('textures'),
    maxReportId: await max('reports'),
    maxOAuthClientId: await max('oauth_clients'),
    playersUpdatedAt: await latest('players'),
    texturesUpdatedAt: await latest('textures'),
  }
}

export async function inspectTarget(db: Kysely<CoreDatabase>): Promise<TargetState> {
  const counts = {
    users: await countRows(db.selectFrom('users')),
    players: await countRows(db.selectFrom('players')),
    textures: await countRows(db.selectFrom('textures')),
  }
  let hasData = false
  for (const table of [...BUSINESS_TABLES, 'texture_files'] as const) {
    if ((await sql`select 1 from ${sql.table(table)} limit 1`.execute(db)).rows.length) {
      hasData = true
      break
    }
  }
  const previous = await lastImport(db)
  if (!hasData) return { counts, hasData, lastImportAt: previous?.finishedAt ?? null, newData: null }
  // 从没导入过：现有的全部都是新站的数据。导入过：按上一次导入记下的范围和完成时间比较
  const since = previous?.finishedAt ?? toIsoTimestamp(new Date(0))
  const mark = previous?.watermark ?? {
    maxUserId: 0,
    maxPlayerId: 0,
    maxTextureId: 0,
    maxReportId: 0,
    maxOAuthClientId: 0,
    playersUpdatedAt: null,
    texturesUpdatedAt: null,
  }
  const later = (stamp: string | null): IsoTimestamp =>
    stamp !== null && stamp > since ? (stamp as IsoTimestamp) : since
  // 定时任务入队的行（去重键是条目名）不是新站的操作
  const unscheduled = <T extends 'jobs' | 'failed_jobs'>(table: T) =>
    countRows(
      db
        .selectFrom(table as 'jobs')
        .where((eb) =>
          eb.or([
            eb('dedupe_key', 'is', null),
            eb('dedupe_key', 'not in', eb.selectFrom('job_schedules').select('name')),
          ]),
        ),
    )
  const newData: NewSiteData = {
    sessions: await countRows(db.selectFrom('sessions')),
    oauthTokens:
      (await countRows(db.selectFrom('oauth_access_tokens'))) +
      (await countRows(db.selectFrom('oauth_refresh_tokens'))) +
      (await countRows(db.selectFrom('oauth_consents'))),
    launcherTokens: await countRows(db.selectFrom('yggdrasil_tokens')),
    scoreTransactions: previous
      ? await countRows(db.selectFrom('score_transactions').where('reason', '!=', IMPORT_SCORE_REASON))
      : await countRows(db.selectFrom('score_transactions')),
    users: await countRows(db.selectFrom('users').where('id', '>', mark.maxUserId)),
    players: await countRows(
      db
        .selectFrom('players')
        .where((eb) => eb.or([eb('id', '>', mark.maxPlayerId), eb('updated_at', '>', later(mark.playersUpdatedAt))])),
    ),
    textures: await countRows(
      db
        .selectFrom('textures')
        .where((eb) => eb.or([eb('id', '>', mark.maxTextureId), eb('updated_at', '>', later(mark.texturesUpdatedAt))])),
    ),
    // 导入的衣柜记录取导入开始的时刻，早于导入完成
    closetItems: await countRows(db.selectFrom('closet_items').where('created_at', '>', since)),
    reports: await countRows(
      db.selectFrom('reports').where((eb) => eb.or([eb('id', '>', mark.maxReportId), eb('resolved_at', '>', since)])),
    ),
    oauthClients: await countRows(db.selectFrom('oauth_clients').where('id', '>', mark.maxOAuthClientId)),
    auditLogs: await countRows(db.selectFrom('audit_logs')),
    other:
      (await countRows(db.selectFrom('verifications'))) +
      (await countRows(db.selectFrom('two_factors'))) +
      (await countRows(db.selectFrom('passkeys'))) +
      (await countRows(db.selectFrom('device_codes'))) +
      (await countRows(db.selectFrom('device_code_selections'))) +
      (await unscheduled('jobs')) +
      (await unscheduled('failed_jobs')),
  }
  return { counts, hasData, lastImportAt: previous?.finishedAt ?? null, newData }
}

/**
 * 能不能写：没有业务数据直接写；数据来自上一次导入，要 replace；上一次导入之后新站产生了数据，
 * 或者有数据却从没导入过，还要 force。返回不满足时的停止类问题
 */
export function targetIssue(state: TargetState, flags: { replace: boolean; force: boolean }): BlockingIssue | null {
  if (!state.hasData) return null
  const fresh = state.lastImportAt === null || Object.values(state.newData ?? {}).some((count) => count > 0)
  const needs = fresh ? 'force' : 'replace'
  const allowed = flags.replace && (needs === 'replace' || flags.force)
  return allowed
    ? null
    : { code: 'target_not_empty', needs, current: state.counts, newData: fresh ? state.newData : null }
}

/**
 * 清空业务数据：用户（连同账号、会话、角色、衣柜、令牌）、材质、举报、OAuth 客户端、积分流水、审计日志、任务。
 * 保留 settings、jwks、job_schedules、import_runs、迁移记录和 oauth_resources（站点自己的配置）。
 * texture_files 留到最后：上一次导入的行要用来沿用像素 hash（textures.ts）
 */
export async function clearBusinessData(db: Kysely<CoreDatabase>): Promise<void> {
  for (const table of BUSINESS_TABLES) await db.deleteFrom(table).execute()
}
