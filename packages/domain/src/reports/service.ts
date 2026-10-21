import {
  countRows,
  insertOrIgnore,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type IsoTimestamp,
  type TextureType,
} from '@nextskin/db'
import type { Kysely } from 'kysely'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import { textureScaleOrNull } from '../players/queries.ts'
import { adjustScore } from '../score/adjust.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { rejectNul } from '../text.ts'
import { lockTexture } from '../textures/manage.ts'
import { assertUserActionAllowed } from '../users/action.ts'
import type { UserActionInterceptor } from '../plugins/system.ts'
import { assertPlayerManagementAllowed, lockUser, type UserActor } from '../users/lock.ts'

export interface Report {
  id: number
  tid: number
  reason: string
  status: 'pending' | 'resolved' | 'rejected'
  scorePaid: number
  createdAt: IsoTimestamp
}
export interface OwnReport {
  id: number
  /** 已删除或现在对举报人不可见的材质为 null */
  texture: { tid: number; name: string; type: TextureType; hash: string; scale: number } | null
  reason: string
  status: 'pending' | 'resolved' | 'rejected'
  scorePaid: number
  createdAt: IsoTimestamp
  resolvedAt: IsoTimestamp | null
}
export function createReports(options: {
  interceptUserAction: UserActionInterceptor
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  events: Events
  now: () => Date
}) {
  const { db, settings, events, now, interceptUserAction } = options
  return {
    async create(actor: UserActor, input: { tid: number; reason: string }): Promise<Report> {
      const reason = rejectNul(input.reason).trim()
      if ([...reason].length < 1 || [...reason].length > 500)
        throw new DomainError('report_reason_length', { min: 1, max: 500 })
      const values = await settings.read(['auth.requireEmailVerification', 'report.cost'])
      await assertUserActionAllowed(interceptUserAction, actor.uid, 'report.create')
      return transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
        const texture = await lockTexture(tx, input.tid)
        if (!texture || (texture.is_public === 0 && texture.uploader_id !== actor.uid))
          throw new DomainError('texture_not_found')
        const timestamp = toIsoTimestamp(now())
        const paid = values['report.cost']
        if (
          !(await insertOrIgnore(
            tx,
            'reports',
            {
              texture_id: input.tid,
              uploader_id: texture.uploader_id,
              reporter_id: actor.uid,
              reason,
              status: 'pending',
              score_paid: paid,
              created_at: timestamp,
            },
            ['reporter_id', 'texture_id'],
          ))
        )
          throw new DomainError('report_duplicate')
        const { id } = await tx
          .selectFrom('reports')
          .select('id')
          .where('reporter_id', '=', actor.uid)
          .where('texture_id', '=', input.tid)
          .executeTakeFirstOrThrow()
        if (paid > 0)
          await adjustScore(tx, {
            uid: actor.uid,
            delta: -paid,
            reason: 'score.reasons.reportCreated',
            subject: { type: 'report', id },
            now: timestamp,
          })
        await events.emit(
          tx,
          'report.created',
          { kind: 'user', uid: actor.uid, role: user.role },
          { reportId: id, tid: input.tid, reporter: actor.uid },
          timestamp,
        )
        return { id, tid: input.tid, reason, status: 'pending', scorePaid: paid, createdAt: timestamp }
      })
    },
    async listOwn(
      uid: number,
      input: { page: number; perPage?: number },
    ): Promise<{ items: OwnReport[]; total: number }> {
      const perPage = Math.max(1, Math.min(60, Math.trunc(input.perPage ?? 20)))
      const page = Math.max(1, Math.trunc(input.page))
      const query = db.selectFrom('reports').where('reports.reporter_id', '=', uid)
      const total = await countRows(query)
      const found = await query
        .leftJoin('textures', 'textures.id', 'reports.texture_id')
        .leftJoin('texture_files', 'texture_files.hash', 'textures.hash')
        .select([
          'reports.id',
          'reports.reason',
          'reports.status',
          'reports.score_paid as scorePaid',
          'reports.created_at as createdAt',
          'reports.resolved_at as resolvedAt',
          'textures.id as tid',
          'textures.name',
          'textures.type',
          'textures.hash',
          'textures.is_public',
          'textures.uploader_id',
          'texture_files.width',
          'texture_files.height',
        ])
        .orderBy('reports.id', 'desc')
        .limit(perPage)
        .offset((page - 1) * perPage)
        .execute()
      return {
        total,
        items: found.map(({ tid, name, type, hash, is_public, uploader_id, width, height, ...report }) => ({
          ...report,
          texture:
            tid !== null && name !== null && type !== null && hash !== null && (is_public === 1 || uploader_id === uid)
              ? // 旧尺寸不合法时保留材质信息，预览按标准倍率回退。
                { tid, name, type, hash, scale: textureScaleOrNull(type, width, height) ?? 1 }
              : null,
        })),
      }
    },
  }
}
