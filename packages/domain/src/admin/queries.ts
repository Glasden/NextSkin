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
import { can, hasAdminAccess, outranks, type CorePermission } from '../access/permissions.ts'
import { countAuthorizedApps } from '../oauth/clients.ts'
import { DomainError } from '../errors.ts'
import { textureScaleOrNull, toNameKey } from '../players/queries.ts'
import { textureRows } from '../textures/dto.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { rejectNul } from '../text.ts'
import { todayStart } from '../time.ts'
import type {
  AdminClosetItem,
  AdminOverview,
  AdminPlayer,
  AdminReport,
  AdminTextureForOwner,
  AdminUser,
  AdminUserDetail,
  AdminUserLookup,
  AuditEntry,
} from './types.ts'

const MAX_INT32 = 2147483647
/** 带不带连字符都行（ADR-0036"后台的角色管理"） */
const UUID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

/**
 * 后台衣柜项：别人的私有材质只有 textures.manage 才给出名字和预览（ADR-0036"别人的材质"）。
 * 衣柜名默认就是材质名，所以一并隐藏。衣柜列表和后台加入衣柜的响应共用
 */
export function toAdminClosetItem(item: AdminClosetItem, reveal: boolean): AdminClosetItem {
  return reveal ? item : { ...item, name: null, texture: null }
}

export function pagination(input: { page: number; perPage?: number }) {
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
/** 只要昵称和头像：插件的表格里按 uid 渲染用户（ADR-0033） */
export async function userSummaries(
  db: Kysely<CoreDatabase>,
  uids: readonly number[],
): Promise<Pick<AdminUser, 'uid' | 'nickname' | 'avatar'>[]> {
  if (!uids.length) return []
  return (
    await userRows(db)
      .where('users.id', 'in', [...uids])
      .execute()
  ).map((row) => {
    const { uid, nickname, avatar } = toUser(row)
    return { uid, nickname, avatar }
  })
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

const subjectTables = { oauthClient: 'oauth_clients', user: 'users', texture: 'textures', report: 'reports' } as const

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
function playerRows(db: Kysely<CoreDatabase>) {
  return db
    .selectFrom('players')
    .innerJoin('users as owner', 'owner.id', 'players.user_id')
    .leftJoin('textures as skin', 'skin.id', 'players.skin_texture_id')
    .leftJoin('textures as cape', 'cape.id', 'players.cape_texture_id')
    .leftJoin('texture_files as skinFile', 'skinFile.hash', 'skin.hash')
    .leftJoin('texture_files as capeFile', 'capeFile.hash', 'cape.hash')
    .select([
      'players.id as pid',
      'players.name',
      'players.uuid',
      'players.score_paid as scorePaid',
      'players.updated_at as updatedAt',
      'owner.id as ownerId',
      'owner.nickname as ownerNickname',
      'owner.role as ownerRole',
      'skin.id as skinId',
      'skin.hash as skinHash',
      'skin.type as skinType',
      'skin.is_public as skinPublic',
      'skin.uploader_id as skinUploader',
      'skinFile.width as skinWidth',
      'skinFile.height as skinHeight',
      'cape.id as capeId',
      'cape.hash as capeHash',
      'cape.type as capeType',
      'cape.is_public as capePublic',
      'cape.uploader_id as capeUploader',
      'capeFile.width as capeWidth',
      'capeFile.height as capeHeight',
    ])
}
type PlayerRow = Awaited<ReturnType<ReturnType<typeof playerRows>['execute']>>[number]

/** reveal 判断能不能给出这个材质的预览：别人的私有材质要有 textures.manage */
function toAdminPlayer(
  row: PlayerRow,
  reveal: (isPublic: number | null, uploader: number | null) => boolean,
): AdminPlayer {
  return {
    pid: row.pid,
    name: row.name,
    uuid: row.uuid,
    scorePaid: row.scorePaid,
    updatedAt: row.updatedAt,
    owner: { uid: row.ownerId, nickname: row.ownerNickname, role: row.ownerRole },
    skin:
      row.skinId === null || row.skinHash === null || row.skinType === null
        ? null
        : reveal(row.skinPublic, row.skinUploader)
          ? {
              tid: row.skinId,
              hash: row.skinHash,
              type: row.skinType,
              scale: textureScaleOrNull(row.skinType, row.skinWidth, row.skinHeight),
            }
          : { tid: row.skinId, hidden: true },
    cape:
      row.capeId === null || row.capeHash === null
        ? null
        : reveal(row.capePublic, row.capeUploader)
          ? {
              tid: row.capeId,
              hash: row.capeHash,
              scale: textureScaleOrNull(row.capeType, row.capeWidth, row.capeHeight),
            }
          : { tid: row.capeId, hidden: true },
  }
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
    return user.role
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
    /** 用户详情页（ADR-0036"页面"）：要有 users.ban，同用户列表；用户不存在返回 null */
    async userDetail(viewer: number, uid: number): Promise<AdminUserDetail | null> {
      await authorize(viewer, 'users.ban')
      const row = await userRows(db)
        .select(['users.locale', 'users.two_factor_enabled'])
        .where('users.id', '=', uid)
        .executeTakeFirst()
      if (!row) return null
      const current = toIsoTimestamp(now())
      const ownTextures = db.selectFrom('textures').where('uploader_id', '=', uid)
      const recentScore = await db
        .selectFrom('score_transactions')
        .select(['id', 'delta', 'balance', 'reason', 'created_at'])
        .where('user_id', '=', uid)
        .orderBy('id', 'desc')
        .limit(10)
        .execute()
      const players = await db
        .selectFrom('players')
        .select(['id', 'name', 'uuid'])
        .where('user_id', '=', uid)
        .orderBy('id')
        .limit(100)
        .execute()
      const recentAudit = await db
        .selectFrom('audit_logs')
        .select('id')
        .where('subject_type', '=', 'user')
        .where('subject_id', '=', uid)
        .orderBy('id', 'desc')
        .limit(10)
        .execute()
      return {
        user: {
          ...toUser(row),
          locale: row.locale,
          twoFactorEnabled: readAuthBoolean(row.two_factor_enabled ?? false),
        },
        recentScore: recentScore.map((r) => ({
          id: r.id,
          delta: r.delta,
          balance: r.balance,
          reason: r.reason,
          createdAt: r.created_at,
        })),
        // 同"最后一种登录方式"的判断：密码行在、密码不为空才算有密码（第三方登录建的账号没有这一行）
        hasPassword:
          (await countRows(
            db
              .selectFrom('accounts')
              .where('user_id', '=', uid)
              .where('provider_id', '=', 'credential')
              .where('password', 'is not', null)
              .where('password', '!=', ''),
          )) > 0,
        counts: {
          sessions: await countRows(
            db.selectFrom('sessions').where('user_id', '=', uid).where('expires_at', '>', writeAuthDate(db, current)),
          ),
          launcherTokens: await countRows(
            db.selectFrom('yggdrasil_tokens').where('user_id', '=', uid).where('expires_at', '>', current),
          ),
          passkeys: await countRows(db.selectFrom('passkeys').where('user_id', '=', uid)),
          players: await countRows(db.selectFrom('players').where('user_id', '=', uid)),
          publicTextures: await countRows(ownTextures.where('is_public', '=', 1)),
          privateTextures: await countRows(ownTextures.where('is_public', '=', 0)),
          closetItems: await countRows(db.selectFrom('closet_items').where('user_id', '=', uid)),
          oauthClients: await countRows(db.selectFrom('oauth_clients').where('user_id', '=', uid)),
          authorizedApps: await countAuthorizedApps(db, uid, current),
        },
        players: players.map((p) => ({ pid: p.id, name: p.name, uuid: p.uuid })),
        recentAudit: await auditViews(
          db,
          recentAudit.map((r) => r.id),
        ),
      }
    },
    async listCloset(
      viewer: number,
      uid: number,
      input: { page: number; perPage?: number },
    ): Promise<{ total: number; items: AdminClosetItem[] }> {
      const role = await authorize(viewer, 'users.ban')
      const { limit, offset } = pagination(input)
      const query = db
        .selectFrom('closet_items')
        .innerJoin('textures', 'textures.id', 'closet_items.texture_id')
        .innerJoin('texture_files', 'texture_files.hash', 'textures.hash')
        .where('closet_items.user_id', '=', uid)
      const rows = await query
        .select([
          'closet_items.texture_id as tid',
          'closet_items.name',
          'closet_items.score_paid as scorePaid',
          'closet_items.created_at as addedAt',
          'textures.name as textureName',
          'textures.type',
          'textures.hash',
          'textures.is_public',
          'textures.uploader_id',
          'texture_files.width',
          'texture_files.height',
        ])
        .orderBy('closet_items.created_at', 'desc')
        .orderBy('closet_items.texture_id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute()
      return {
        total: await countRows(query),
        items: rows.map((row) =>
          toAdminClosetItem(
            {
              tid: row.tid,
              name: row.name,
              scorePaid: row.scorePaid,
              addedAt: row.addedAt,
              visibleToOwner: row.is_public === 1 || row.uploader_id === uid,
              texture: {
                name: row.textureName,
                type: row.type,
                hash: row.hash,
                public: row.is_public === 1,
                scale: textureScaleOrNull(row.type, row.width, row.height) ?? 1,
              },
            },
            row.is_public === 1 || row.uploader_id === viewer || can(role, 'textures.manage'),
          ),
        ),
      }
    },
    /**
     * 角色页（ADR-0036"后台的角色管理"）：按角色名不分大小写地包含匹配，或者按 UUID 精确查找；owner 列出某个用户的角色。
     * 按 pid 从新到旧。按 owner 筛选时一并给出主人的昵称，用户不存在时为 null。别人的私有材质要有 textures.manage 才给出预览
     */
    async listPlayers(viewer: number, input: { q?: string; owner?: number; page: number; perPage?: number }) {
      const role = await authorize(viewer, 'players.manage')
      const textures = can(role, 'textures.manage')
      const reveal = (isPublic: number | null, uploader: number | null) =>
        textures || isPublic === 1 || uploader === viewer
      const { limit, offset } = pagination(input)
      const q = rejectNul(input.q ?? '').trim()
      const filter = <Q extends SelectQueryBuilder<CoreDatabase, 'players', object>>(query: Q): Q => {
        let filtered = query
        if (q)
          filtered = filtered.where((eb) =>
            eb.or([
              // name_key 是 JS 转的小写，SQLite 的 lower() 只认 ASCII，所以拿它和转好小写的输入比
              containsInsensitive('players.name_key', toNameKey(q)),
              ...(UUID_PATTERN.test(q) ? [eb('players.uuid', '=', q.replaceAll('-', '').toLowerCase())] : []),
            ]),
          ) as Q
        if (input.owner !== undefined) filtered = filtered.where('players.user_id', '=', input.owner) as Q
        return filtered
      }
      const rows = await filter(playerRows(db)).orderBy('players.id', 'desc').limit(limit).offset(offset).execute()
      const owner =
        input.owner === undefined
          ? undefined
          : ((await db
              .selectFrom('users')
              .select(['id', 'nickname'])
              .where('id', '=', input.owner)
              .executeTakeFirst()) ?? null)
      return {
        total: await countRows(filter(db.selectFrom('players'))),
        items: rows.map((row) => toAdminPlayer(row, reveal)),
        ...(owner === undefined ? {} : { owner: owner && { uid: owner.id, nickname: owner.nickname } }),
      }
    },
    /**
     * 转让时按 uid 或邮箱精确查新主人（ADR-0036"接口"）：要有 players.manage，只返回身份严格低于自己的用户，其余一律
     * user_not_found。按邮箱查、返回邮箱还要有 users.ban，否则拿一个邮箱试探就能查出它属于谁
     */
    async lookupUser(viewer: number, q: string): Promise<AdminUserLookup> {
      const self = await db.selectFrom('users').select('role').where('id', '=', viewer).executeTakeFirst()
      if (!self || !can(self.role, 'players.manage')) throw new DomainError('permission_denied')
      const emails = can(self.role, 'users.ban')
      const query = rejectNul(q).trim()
      const row = /^\d+$/.test(query)
        ? Number(query) <= MAX_INT32
          ? await userRows(db).where('users.id', '=', Number(query)).executeTakeFirst()
          : undefined
        : emails && query
          ? await userRows(db).where('users.email', '=', query.toLowerCase()).executeTakeFirst()
          : undefined
      if (!row || !outranks(self.role, row.role)) throw new DomainError('user_not_found')
      const { uid, nickname, email, role, avatar } = toUser(row)
      return { uid, nickname, email: emails ? email : null, role, avatar }
    },
    /**
     * 按 tid 查材质、判断主人能不能用（ADR-0036"接口"）：转让和换材质、加入衣柜的 Dialog 在提交之前用。要有 players.manage
     * 或 users.manage，owner 要是自己能管理的用户。别人的私有材质在没有 textures.manage 时只给出 tid、public 和 visibleToOwner
     */
    async textureForOwner(viewer: number, tid: number, owner: number): Promise<AdminTextureForOwner> {
      const users = await db.selectFrom('users').select(['id', 'role']).where('id', 'in', [viewer, owner]).execute()
      const self = users.find((user) => user.id === viewer)
      if (!self || !(can(self.role, 'players.manage') || can(self.role, 'users.manage')))
        throw new DomainError('permission_denied')
      const target = users.find((user) => user.id === owner)
      if (!target) throw new DomainError('user_not_found')
      if (!outranks(self.role, target.role)) throw new DomainError('user_not_manageable')
      const row = await textureRows(db).where('textures.id', '=', tid).executeTakeFirst()
      if (!row) throw new DomainError('texture_not_found')
      const visibleToOwner = row.is_public === 1 || row.uploader_id === owner
      if (row.is_public === 0 && row.uploader_id !== viewer && !can(self.role, 'textures.manage'))
        return { tid: row.id, public: false, visibleToOwner }
      return {
        tid: row.id,
        name: row.name,
        type: row.type,
        public: row.is_public === 1,
        uploaderId: row.uploader_id,
        hash: row.hash,
        scale: textureScaleOrNull(row.type, row.width, row.height),
        visibleToOwner,
      }
    },
    async textureDeletionImpact(
      viewer: number,
      tid: number,
    ): Promise<{ likes: number; pendingReports: number; othersInCloset: number } | null> {
      const user = await db.selectFrom('users').select('role').where('id', '=', viewer).executeTakeFirst()
      if (!user || !can(user.role, 'textures.manage')) return null
      const texture = await db
        .selectFrom('textures')
        .select(['likes', 'uploader_id'])
        .where('id', '=', tid)
        .executeTakeFirst()
      return texture
        ? {
            likes: texture.likes,
            othersInCloset: await countRows(
              db
                .selectFrom('closet_items')
                .where('texture_id', '=', tid)
                .$if(texture.uploader_id !== null, (query) => query.where('user_id', '!=', texture.uploader_id!)),
            ),
            pendingReports: await countRows(
              db.selectFrom('reports').where('texture_id', '=', tid).where('status', '=', 'pending'),
            ),
          }
        : null
    },
  }
}
