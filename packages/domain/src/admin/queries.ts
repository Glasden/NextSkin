import {
  containsInsensitive,
  countRows,
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
  type UserRole,
} from '@nextskin/db'
import type { Kysely, SelectQueryBuilder } from 'kysely'
import { can, hasAdminAccess, type CorePermission } from '../access/permissions.ts'
import { DomainError } from '../errors.ts'
import { textureScaleOrNull } from '../players/queries.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { rejectNul } from '../text.ts'
import type { AdminOverview, AdminReport, AdminUser, AuditEntry } from './types.ts'

function pagination(input: { page: number; perPage?: number }) {
  const perPage = Math.max(1, Math.min(100, Math.trunc(input.perPage ?? 50)))
  return { limit: perPage, offset: (Math.max(1, Math.trunc(input.page)) - 1) * perPage }
}

function reportRows(db: Kysely<CoreDatabase>) {
  return db
    .selectFrom('reports')
    .leftJoin('textures', 'textures.id', 'reports.texture_id')
    .leftJoin('texture_files', 'texture_files.hash', 'textures.hash')
    .leftJoin('users as uploader', 'uploader.id', 'reports.uploader_id')
    .leftJoin('users as reporter', 'reporter.id', 'reports.reporter_id')
    .leftJoin('users as resolver', 'resolver.id', 'reports.resolver_id')
    .select([
      'reports.id',
      'reports.status',
      'reports.resolution',
      'reports.reason',
      'reports.score_paid',
      'reports.created_at',
      'reports.resolved_at',
      'textures.id as tid',
      'textures.name',
      'textures.type',
      'textures.hash',
      'textures.is_public',
      'textures.likes',
      'texture_files.width',
      'texture_files.height',
      'uploader.id as uploaderUid',
      'uploader.nickname as uploaderName',
      'uploader.role as uploaderRole',
      'reporter.id as reporterUid',
      'reporter.nickname as reporterName',
      'resolver.id as resolverUid',
      'resolver.nickname as resolverName',
    ])
}
type ReportRow = Awaited<ReturnType<ReturnType<typeof reportRows>['execute']>>[number]

/** 一页举报连同材质、相关的人一次查出来；每个材质上待处理的举报数另查一次，供删除的确认框写明后果 */
async function toReports(db: Kysely<CoreDatabase>, rows: readonly ReportRow[]): Promise<AdminReport[]> {
  // 处理人的账号删除后 resolver_id 被置空：管理操作都写了审计，从审计记录找回是谁处理的
  const orphaned = rows.filter((row) => row.status !== 'pending' && row.resolverUid === null).map((row) => row.id)
  const auditedResolvers = new Map<number, number>()
  if (orphaned.length)
    for (const { subject_id, actor_user_id } of await db
      .selectFrom('audit_logs')
      .select(['subject_id', 'actor_user_id'])
      .where('action', '=', 'report.resolve')
      .where('subject_type', '=', 'report')
      .where('subject_id', 'in', orphaned)
      .execute())
      if (actor_user_id !== null) auditedResolvers.set(subject_id, actor_user_id)
  const tids = [...new Set(rows.flatMap((row) => (row.tid === null ? [] : [row.tid])))]
  const pending = new Map<number, number>()
  if (tids.length)
    for (const { texture_id } of await db
      .selectFrom('reports')
      .select('texture_id')
      .where('status', '=', 'pending')
      .where('texture_id', 'in', tids)
      .execute())
      if (texture_id !== null) pending.set(texture_id, (pending.get(texture_id) ?? 0) + 1)
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    resolution: r.resolution,
    reason: r.reason,
    scorePaid: r.score_paid,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    texture:
      r.tid === null
        ? null
        : {
            tid: r.tid,
            name: r.name!,
            type: r.type!,
            hash: r.hash!,
            public: r.is_public === 1,
            likes: r.likes!,
            scale: textureScaleOrNull(r.type, r.width, r.height) ?? 1,
            pendingReports: pending.get(r.tid) ?? 0,
          },
    uploader: r.uploaderUid === null ? null : { uid: r.uploaderUid, nickname: r.uploaderName!, role: r.uploaderRole! },
    reporter: r.reporterUid === null ? null : { uid: r.reporterUid, nickname: r.reporterName! },
    resolver:
      r.resolverUid !== null
        ? { uid: r.resolverUid, nickname: r.resolverName! }
        : auditedResolvers.has(r.id)
          ? { uid: auditedResolvers.get(r.id)!, nickname: null }
          : null,
  }))
}
export async function reportView(db: Kysely<CoreDatabase>, id: number): Promise<AdminReport> {
  const [report] = await toReports(db, [await reportRows(db).where('reports.id', '=', id).executeTakeFirstOrThrow()])
  return report!
}

/** 头像同 users.avatar 的规则：对本人可见的皮肤（公开的、自己上传的），披风不算 */
function userRows(db: Kysely<CoreDatabase>) {
  return db
    .selectFrom('users')
    .leftJoin('textures as avatar', (join) =>
      join
        .onRef('avatar.id', '=', 'users.avatar_texture_id')
        .on((eb) => eb.or([eb('avatar.is_public', '=', 1), eb('avatar.uploader_id', '=', eb.ref('users.id'))])),
    )
    .leftJoin('texture_files as avatarFile', 'avatarFile.hash', 'avatar.hash')
    .select([
      'users.id',
      'users.nickname',
      'users.email',
      'users.email_verified',
      'users.role',
      'users.score',
      'users.created_at',
      'avatar.hash as avatarHash',
      'avatar.type as avatarType',
      'avatarFile.width as avatarWidth',
      'avatarFile.height as avatarHeight',
    ])
}
type UserRow = Awaited<ReturnType<ReturnType<typeof userRows>['execute']>>[number]

function toUser(row: UserRow): AdminUser {
  const scale =
    row.avatarHash !== null && row.avatarType !== null && row.avatarType !== 'cape'
      ? textureScaleOrNull(row.avatarType, row.avatarWidth, row.avatarHeight)
      : null
  return {
    uid: row.id,
    nickname: row.nickname,
    email: row.email,
    emailVerified: readAuthBoolean(row.email_verified),
    role: row.role,
    score: row.score,
    registeredAt: readAuthDate(row.created_at),
    avatar: row.avatarHash !== null && scale !== null ? { hash: row.avatarHash, scale } : null,
  }
}
export async function userView(db: Kysely<CoreDatabase>, uid: number): Promise<AdminUser> {
  return toUser(await userRows(db).where('users.id', '=', uid).executeTakeFirstOrThrow())
}

/** details 是我们自己写进去的 JSON；读不出对象时当作空的，不让一条坏记录拖垮整页（ADR-0015：读出后校验） */
function parseDetails(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const subjectTables = { user: 'users', texture: 'textures', report: 'reports' } as const

async function auditViews(db: Kysely<CoreDatabase>, ids: number[]): Promise<AuditEntry[]> {
  if (!ids.length) return []
  const rows = await db
    .selectFrom('audit_logs')
    .leftJoin('users', 'users.id', 'audit_logs.actor_user_id')
    .selectAll('audit_logs')
    .select('users.nickname')
    .where('audit_logs.id', 'in', ids)
    .orderBy('audit_logs.id', 'desc')
    .execute()
  // 对象还在不在：每种对象一次查询
  const existing = new Set<string>()
  for (const [type, table] of Object.entries(subjectTables)) {
    const subjectIds = [...new Set(rows.filter((row) => row.subject_type === type).map((row) => row.subject_id))]
    if (subjectIds.length)
      for (const { id } of await db.selectFrom(table).select('id').where('id', 'in', subjectIds).execute())
        existing.add(`${type}:${id}`)
  }
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    createdAt: row.created_at,
    ip: row.ip,
    actor:
      row.actor_type === 'user'
        ? { type: 'user', uid: row.actor_user_id!, nickname: row.nickname }
        : row.actor_type === 'plugin'
          ? { type: 'plugin', pluginId: row.actor_plugin_id! }
          : { type: 'system' },
    subject: {
      type: row.subject_type,
      id: row.subject_id,
      exists: row.subject_type === 'setting' || existing.has(`${row.subject_type}:${row.subject_id}`),
    },
    details: parseDetails(row.details),
  }))
}
/** 按当地日期找第一毫秒，兼容夏令时导致的非 24 小时日。 */
function todayStart(now: Date, timeZone: string) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const day = (value: number) => format.format(new Date(value))
  const target = day(now.getTime())
  let lo = now.getTime() - 48 * 3600000,
    hi = now.getTime()
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (day(mid) < target) lo = mid + 1
    else hi = mid
  }
  return toIsoTimestamp(new Date(lo))
}
export function createAdminQueries(
  db: Kysely<CoreDatabase>,
  settings: ReturnType<typeof createSettingQueries>,
  now: () => Date,
) {
  async function authorize(uid: number, permission?: CorePermission) {
    const user = await db.selectFrom('users').select('role').where('id', '=', uid).executeTakeFirst()
    if (!user || !(permission ? can(user.role, permission) : hasAdminAccess(user.role)))
      throw new DomainError('permission_denied')
  }
  return {
    async overview(viewer: number): Promise<AdminOverview> {
      await authorize(viewer)
      const values = await settings.read(['site.timeZone'])
      const start = todayStart(now(), values['site.timeZone'])
      const recent = await db.selectFrom('audit_logs').select('id').orderBy('id', 'desc').limit(10).execute()
      return {
        pendingReports: await countRows(db.selectFrom('reports').where('status', '=', 'pending')),
        users: await countRows(db.selectFrom('users')),
        textures: await countRows(db.selectFrom('textures')),
        registeredToday: await countRows(db.selectFrom('users').where('created_at', '>=', writeAuthDate(db, start))),
        recentAudit: await auditViews(
          db,
          recent.map((r) => r.id),
        ),
      }
    },
    async listReports(
      viewer: number,
      input: { status: 'pending' | 'resolved' | 'rejected'; page: number; perPage?: number },
    ) {
      await authorize(viewer, 'reports.review')
      const { limit, offset } = pagination(input)
      const rows = await reportRows(db)
        .where('reports.status', '=', input.status)
        .orderBy('reports.id', input.status === 'pending' ? 'asc' : 'desc')
        .limit(limit)
        .offset(offset)
        .execute()
      return {
        total: await countRows(db.selectFrom('reports').where('status', '=', input.status)),
        items: await toReports(db, rows),
        counts: {
          pending: await countRows(db.selectFrom('reports').where('status', '=', 'pending')),
          resolved: await countRows(db.selectFrom('reports').where('status', '=', 'resolved')),
          rejected: await countRows(db.selectFrom('reports').where('status', '=', 'rejected')),
        },
      }
    },
    async listUsers(viewer: number, input: { q?: string; role?: UserRole; page: number; perPage?: number }) {
      await authorize(viewer, 'users.ban')
      const { limit, offset } = pagination(input)
      const q = rejectNul(input.q ?? '').trim()
      const filter = <Q extends SelectQueryBuilder<CoreDatabase, 'users', object>>(query: Q): Q => {
        let filtered = query
        if (q)
          filtered = filtered.where((eb) =>
            eb.or([
              containsInsensitive('users.email', q),
              containsInsensitive('users.nickname', q),
              ...(/^\d+$/.test(q) && Number(q) <= 2147483647 ? [eb('users.id', '=', Number(q))] : []),
            ]),
          ) as Q
        if (input.role !== undefined) filtered = filtered.where('users.role', '=', input.role) as Q
        return filtered
      }
      const rows = await filter(userRows(db)).orderBy('users.id', 'desc').limit(limit).offset(offset).execute()
      return { total: await countRows(filter(db.selectFrom('users'))), items: rows.map(toUser) }
    },
    async listAudit(
      viewer: number,
      input: { subjectType?: string; subjectId?: number; actorUid?: number; page: number; perPage?: number },
    ) {
      await authorize(viewer, 'audit.read')
      const { limit, offset } = pagination(input)
      let query = db.selectFrom('audit_logs')
      if (input.subjectType !== undefined) query = query.where('subject_type', '=', rejectNul(input.subjectType))
      if (input.subjectId !== undefined) query = query.where('subject_id', '=', input.subjectId)
      if (input.actorUid !== undefined) query = query.where('actor_user_id', '=', input.actorUid)
      const ids = await query.select('id').orderBy('id', 'desc').limit(limit).offset(offset).execute()
      return {
        total: await countRows(query),
        items: await auditViews(
          db,
          ids.map((r) => r.id),
        ),
      }
    },
    async textureDeletionImpact(
      viewer: number,
      tid: number,
    ): Promise<{ likes: number; pendingReports: number } | null> {
      const user = await db.selectFrom('users').select('role').where('id', '=', viewer).executeTakeFirst()
      if (!user || !can(user.role, 'textures.manage')) return null
      const texture = await db.selectFrom('textures').select('likes').where('id', '=', tid).executeTakeFirst()
      return texture
        ? {
            likes: texture.likes,
            pendingReports: await countRows(
              db.selectFrom('reports').where('texture_id', '=', tid).where('status', '=', 'pending'),
            ),
          }
        : null
    },
  }
}
