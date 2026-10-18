import { toIsoTimestamp, transactionWithRetry, type CoreDatabase, type IsoTimestamp, type UserRole } from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Kysely, Selectable, Transaction } from 'kysely'
import { can, outranks, type CorePermission } from '../access/permissions.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { lockTexture } from '../textures/manage.ts'
import type { TextureRemoval } from '../textures/removal.ts'
import { lockUser } from '../users/lock.ts'
import { validateEmail } from '../users/validation.ts'
import { createAdminSettings } from './settings.ts'
import type { MailService } from '../mail/service.ts'
import type { SigningKey } from '../yggdrasil/signing-key.ts'
import { createAdminQueries, reportView, userView } from './queries.ts'
import { claimReport, settleReport } from './report-resolution.ts'
import type { AdminActor, AdminReport, AdminUser, AssignableRole, ReportAction } from './types.ts'

export function createAdmin(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  events: Events
  removal: TextureRemoval
  now: () => Date
  secretKey: string
  production: boolean
  mail: MailService
  getSigningKey: () => Promise<SigningKey | null>
}) {
  const { db, settings, events, removal, now } = options
  async function authorize(tx: Transaction<CoreDatabase>, actor: AdminActor, permission: CorePermission) {
    const user = await lockUser(tx, actor.uid)
    if (!can(user.role, permission)) throw new DomainError('permission_denied')
    return { kind: 'user' as const, uid: actor.uid, role: user.role }
  }
  async function targetUser(tx: Transaction<CoreDatabase>, uid: number) {
    await tx
      .updateTable('users')
      .set((eb) => ({ role: eb.ref('role') }))
      .where('id', '=', uid)
      .execute()
    return tx.selectFrom('users').select(['id', 'role', 'nickname']).where('id', '=', uid).executeTakeFirst()
  }
  async function changeRole(
    tx: Transaction<CoreDatabase>,
    target: { id: number; nickname: string; role: UserRole },
    role: UserRole,
    actor: Actor,
    ip: string | null,
    timestamp: IsoTimestamp,
    reportId?: number,
  ) {
    if (target.role === role) return
    await tx.updateTable('users').set({ role }).where('id', '=', target.id).execute()
    await events.emit(tx, 'user.roleChanged', actor, { uid: target.id, from: target.role, to: role }, timestamp)
    await audit(tx, {
      actor,
      action: 'user.setRole',
      subject: { type: 'user', id: target.id },
      details: {
        from: target.role,
        to: role,
        nickname: target.nickname,
        ...(reportId === undefined ? {} : { reportId }),
      },
      ip,
      now: timestamp,
    })
  }
  async function deletionTarget(tx: Transaction<CoreDatabase>, tid: number) {
    const before = await tx.selectFrom('textures').select('uploader_id').where('id', '=', tid).executeTakeFirst()
    // 与上传者自删、删除账号相同：上传者 -> 材质 -> 引用者和举报人。
    if (before?.uploader_id !== null && before?.uploader_id !== undefined) await targetUser(tx, before.uploader_id)
    return lockTexture(tx, tid)
  }
  async function deleteManaged(
    tx: Transaction<CoreDatabase>,
    row: NonNullable<Awaited<ReturnType<typeof lockTexture>>>,
    actor: Extract<Actor, { kind: 'user' }>,
    ip: string | null,
    timestamp: IsoTimestamp,
    values: { 'score.refundOnDelete': boolean; 'report.reward': number },
    claimed?: Selectable<CoreDatabase['reports']>,
  ) {
    const reportId = claimed?.id
    const { resolvedReports } = await removal.remove(tx, row, {
      actor,
      refund: values['score.refundOnDelete'],
      refundUploader: false,
      now: timestamp,
      review: { resolverId: actor.uid, ip, reward: values['report.reward'], claimed },
    })
    await audit(tx, {
      actor,
      action: 'texture.delete',
      subject: { type: 'texture', id: row.id },
      details: {
        name: row.name,
        type: row.type,
        hash: row.hash,
        public: row.is_public === 1,
        uploaderId: row.uploader_id,
        ...(reportId === undefined ? {} : { reportId }),
      },
      ip,
      now: timestamp,
    })
    return { resolvedReports }
  }
  return {
    async requirePermission(uid: number, permission: CorePermission): Promise<void> {
      const user = await db.selectFrom('users').select('role').where('id', '=', uid).executeTakeFirst()
      if (!user) throw new DomainError('unauthenticated')
      if (!can(user.role, permission)) throw new DomainError('permission_denied')
    },
    ...createAdminQueries(db, settings, now),
    ...createAdminSettings({ ...options, authorize }),
    async setRole(actor: AdminActor, uid: number, role: AssignableRole): Promise<AdminUser> {
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'users.ban')
        if (!['banned', 'user', 'admin'].includes(role)) throw new DomainError('invalid_request')
        const target = await targetUser(tx, uid)
        if (!target) throw new DomainError('user_not_found')
        if (!outranks(eventActor.role, target.role)) throw new DomainError('user_not_manageable')
        if (role === 'admin' && !can(eventActor.role, 'users.appointAdmin')) throw new DomainError('permission_denied')
        await changeRole(tx, target, role, eventActor, actor.ip, toIsoTimestamp(now()))
        return userView(tx, uid)
      })
    },
    async setRoleAsSystem(email: string, role: UserRole): Promise<AdminUser> {
      if (!['banned', 'user', 'admin', 'superadmin'].includes(role)) throw new DomainError('invalid_request')
      const normalized = validateEmail(email, { mode: 'deny', domains: [] })
      return transactionWithRetry(db, async (tx) => {
        const found = await tx.selectFrom('users').select('id').where('email', '=', normalized).executeTakeFirst()
        if (!found) throw new DomainError('user_not_found')
        const target = await targetUser(tx, found.id)
        if (!target) throw new DomainError('user_not_found')
        await changeRole(tx, target, role, { kind: 'system' }, null, toIsoTimestamp(now()))
        return userView(tx, target.id)
      })
    },
    async deleteTexture(actor: AdminActor, tid: number): Promise<{ resolvedReports: number }> {
      const values = await settings.read(['score.refundOnDelete', 'report.reward'])
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'textures.manage')
        const row = await deletionTarget(tx, tid)
        if (!row) throw new DomainError('texture_not_found')
        return deleteManaged(tx, row, eventActor, actor.ip, toIsoTimestamp(now()), values)
      })
    },
    async resolveReport(actor: AdminActor, id: number, action: ReportAction): Promise<AdminReport> {
      const values = await settings.read(['score.refundOnDelete', 'report.reward'])
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'reports.review')
        if (!['dismiss', 'deleteTexture', 'banUploader'].includes(action)) throw new DomainError('invalid_request')
        const before = await tx.selectFrom('reports').selectAll().where('id', '=', id).executeTakeFirst()
        if (!before) throw new DomainError('report_not_found')
        if (before.status !== 'pending') throw new DomainError('report_already_handled')
        let uploader
        if (action === 'banUploader' && before.uploader_id !== null) uploader = await targetUser(tx, before.uploader_id)
        const texture =
          before.texture_id === null
            ? undefined
            : action === 'deleteTexture'
              ? await deletionTarget(tx, before.texture_id)
              : await lockTexture(tx, before.texture_id)
        // 获得材质锁后再推进状态；删除路径不会在持有举报锁时反向等待上传者。
        const timestamp = toIsoTimestamp(now())
        const report = await claimReport(tx, id, action, actor.uid, timestamp)
        if (!report) throw new DomainError('report_already_handled')
        if (action === 'deleteTexture') {
          if (!can(eventActor.role, 'textures.manage')) throw new DomainError('permission_denied')
          if (!texture) throw new DomainError('texture_not_found')
          // 这条举报和材质上其余的待处理举报一起，在删除流程里按举报人 uid 升序结算
          await deleteManaged(tx, texture, eventActor, actor.ip, timestamp, values, report)
          return reportView(tx, id)
        }
        if (action === 'banUploader') {
          if (!can(eventActor.role, 'users.ban')) throw new DomainError('permission_denied')
          if (!uploader) throw new DomainError('user_not_found')
          if (!outranks(eventActor.role, uploader.role)) throw new DomainError('user_not_manageable')
          await changeRole(tx, uploader, 'banned', eventActor, actor.ip, timestamp, id)
        }
        await settleReport(tx, events, report, {
          actor: eventActor,
          action,
          reward: values['report.reward'],
          ip: actor.ip,
          management: true,
          now: timestamp,
        })
        return reportView(tx, id)
      })
    },
  }
}
