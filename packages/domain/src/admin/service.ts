import { toIsoTimestamp, transactionWithRetry, type CoreDatabase, type IsoTimestamp, type UserRole } from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Kysely, Selectable, Transaction } from 'kysely'
import { can, outranks, type CorePermission } from '../access/permissions.ts'
import { DomainError } from '../errors.ts'
import type { CaptchaService } from '../captcha/service.ts'
import type { Events } from '../events/emit.ts'
import type { JobHandler, JobRunner } from '../jobs/runner.ts'
import { createAdminNotifications } from '../notifications/admin.ts'
import type { PluginSystem } from '../plugins/system.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { lockTexture } from '../textures/manage.ts'
import type { TextureRemoval } from '../textures/removal.ts'
import { validateEmail } from '../users/validation.ts'
import { createAdminSettings } from './settings.ts'
import type { MailService } from '../mail/service.ts'
import type { SigningKey } from '../yggdrasil/signing-key.ts'
import { authorize, changeRole, lockTarget } from './context.ts'
import { createAdminTextures } from './textures.ts'
import { createAdminCloset } from './closet.ts'
import { createAdminFailedJobs } from './failed-jobs.ts'
import { createAdminOAuthClients } from './oauth-clients.ts'
import { createAdminPlayers } from './players.ts'
import { createAdminQueries, reportView, userView } from './queries.ts'
import { claimReport, settleReport } from './report-resolution.ts'
import { createAdminUserDeletion } from './user-deletion.ts'
import { createAdminUsers } from './users.ts'
import { auditTextureDeletion } from '../users/deletion.ts'
import type { SiteImageStorage } from '../site-images/storage.ts'
import type { ImagePool } from '../textures/image-pool.ts'
import type { AdminActor, AdminReport, AdminUser, AssignableRole, ReportAction } from './types.ts'

export interface AdminOptions {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  events: Events
  removal: TextureRemoval
  now: () => Date
  secretKey: string
  production: boolean
  mail: MailService
  captcha: CaptchaService
  jobs: Pick<JobRunner, 'enqueue'>
  /** 执行器登记的处理函数：判断失败的核心任务能不能重试（ADR-0051） */
  handlers: ReadonlyMap<string, JobHandler>
  /** 第三方登录的 Provider：解绑时判断能不能用、通知邮件里按收件人的语言翻译名称（ADR-0034） */
  plugins: Pick<PluginSystem, 'loginProviders' | 'translate' | 'get'>
  getSigningKey: () => Promise<SigningKey | null>
  /** 站点图片的存储和处理（ADR-0042） */
  siteImages: SiteImageStorage
  imagePool: Pick<ImagePool, 'processSiteImage'>
}

export function createAdmin(options: AdminOptions) {
  const { db, settings, events, removal, now } = options
  const users = createAdminUsers(options)
  async function deletionTarget(tx: Transaction<CoreDatabase>, tid: number) {
    const before = await tx.selectFrom('textures').select('uploader_id').where('id', '=', tid).executeTakeFirst()
    // 与上传者自删、删除账号相同：上传者 -> 材质 -> 引用者和举报人。
    if (before?.uploader_id !== null && before?.uploader_id !== undefined) await lockTarget(tx, before.uploader_id)
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
    const { resolvedReports } = await removal.remove(tx, row, {
      actor,
      refund: values['score.refundOnDelete'],
      refundUploader: false,
      now: timestamp,
      review: { resolverId: actor.uid, ip, reward: values['report.reward'], claimed },
    })
    await auditTextureDeletion(tx, { actor, row, ip, now: timestamp, reportId: claimed?.id })
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
    ...users,
    ...createAdminUserDeletion(options),
    ...createAdminPlayers(options),
    ...createAdminOAuthClients(options),
    ...createAdminTextures(options),
    ...createAdminCloset(options),
    ...createAdminFailedJobs(options),
    ...createAdminNotifications(options),
    /** 只改身份：PATCH 只带 role 时的说法，规则见 updateUser */
    setRole(actor: AdminActor, uid: number, role: AssignableRole): Promise<AdminUser> {
      return users.updateUser(actor, uid, { role })
    },
    async setRoleAsSystem(email: string, role: UserRole): Promise<AdminUser> {
      if (!['banned', 'user', 'admin', 'superadmin'].includes(role)) throw new DomainError('invalid_request')
      const normalized = validateEmail(email, { mode: 'deny', domains: [] })
      return transactionWithRetry(db, async (tx) => {
        const found = await tx.selectFrom('users').select('id').where('email', '=', normalized).executeTakeFirst()
        if (!found) throw new DomainError('user_not_found')
        const target = await lockTarget(tx, found.id)
        if (!target) throw new DomainError('user_not_found')
        await changeRole(tx, events, target, role, { kind: 'system' }, null, toIsoTimestamp(now()))
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
        if (action === 'banUploader' && before.uploader_id !== null) uploader = await lockTarget(tx, before.uploader_id)
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
          await changeRole(tx, events, uploader, 'banned', eventActor, actor.ip, timestamp, id)
        }
        await settleReport(tx, events, report, {
          actor: eventActor,
          action,
          reward: values['report.reward'],
          ip: actor.ip,
          management: true,
          textureName: texture?.name ?? '',
          now: timestamp,
        })
        return reportView(tx, id)
      })
    },
  }
}
