import { countRows, toIsoTimestamp, transactionWithRetry } from '@nextskin/db'
import type { CorePermission } from '../access/permissions.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import { lockTexture } from '../textures/manage.ts'
import { auditTextureDeletion, deleteAccountData } from '../users/deletion.ts'
import { authorize, manageableTarget, precheck } from './context.ts'
import type { AdminOptions } from './service.ts'
import type { AdminActor, PublicTexturesOnDelete } from './types.ts'

/** `user.delete` 的快照里最多列出多少个留下的公开材质：MySQL 上 details 是 text，最长 64 KB（ADR-0036"删除用户"） */
const KEPT_TIDS_LIMIT = 100

export function createAdminUserDeletion(options: AdminOptions) {
  const { db, settings, events, removal, now } = options
  return {
    /**
     * 后台删除用户（ADR-0036"删除用户"）。不要密码，被封禁的用户也能删；连带事件和审计的 actor 是管理员，不发通知。
     *
     * `publicTextures: 'delete'` 时先删公开材质，一个材质一个事务：公开材质的引用者多，每个都要找人、退款、发事件，
     * 几百个放进一个事务会把 SQLite 的全局写锁占得远超等待时间。中途失败时已经删掉的不恢复，重新提交接着删剩下的。
     * 最后一个事务写快照审计、删账号（私有材质照旧在这个事务里，同用户自删）
     */
    async deleteUser(actor: AdminActor, uid: number, input: { publicTextures: PublicTexturesOnDelete }): Promise<void> {
      if (input.publicTextures !== 'keep' && input.publicTextures !== 'delete') throw new DomainError('invalid_request')
      const deletePublic = input.publicTextures === 'delete'
      const permissions: CorePermission[] = deletePublic ? ['users.manage', 'textures.manage'] : ['users.manage']
      // 查快照之前先预检，每个材质的事务里还会锁住之后重新判断
      await precheck(db, actor, uid, ...permissions)
      const { 'score.refundOnDelete': refund } = await settings.read(['score.refundOnDelete'])
      if (deletePublic) {
        // 事务外的快照：之后才上传的公开材质照常留下（确认框建议先封禁）
        const snapshot = await db
          .selectFrom('textures')
          .select('id')
          .where('uploader_id', '=', uid)
          .where('is_public', '=', 1)
          .orderBy('id')
          .execute()
        for (const { id } of snapshot)
          await transactionWithRetry(db, async (tx) => {
            // 加锁顺序同管理员删除材质：自己 -> 上传者 -> 材质 -> 引用者和举报人
            const eventActor = await authorize(tx, actor, ...permissions)
            await manageableTarget(tx, eventActor, uid)
            const row = await lockTexture(tx, id)
            // 快照之后被删掉或改成私有的跳过：私有的随账号一起删
            if (!row || row.uploader_id !== uid || row.is_public !== 1) return
            const timestamp = toIsoTimestamp(now())
            // 照管理员删除材质处理，只是不发奖励：删一个账号时并没有逐个审查这些材质
            await removal.remove(tx, row, {
              actor: eventActor,
              refund,
              refundUploader: false,
              deletedAccountUid: uid,
              now: timestamp,
              review: { resolverId: actor.uid, ip: actor.ip, reward: 0 },
            })
            await auditTextureDeletion(tx, { actor: eventActor, row, ip: actor.ip, now: timestamp })
          })
      }
      await transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, ...permissions)
        const target = await manageableTarget(tx, eventActor, uid)
        const timestamp = toIsoTimestamp(now())
        const keptPublic = tx.selectFrom('textures').where('uploader_id', '=', uid).where('is_public', '=', 1)
        const kept = await keptPublic.select('id').orderBy('id').limit(KEPT_TIDS_LIMIT).execute()
        // 角色的 UUID 不放进快照，各自记在 player.delete 里：列表没有上限，details 放不下
        await audit(tx, {
          actor: eventActor,
          action: 'user.delete',
          subject: { type: 'user', id: uid },
          details: {
            nickname: target.nickname,
            email: target.email,
            role: target.role,
            score: target.score,
            players: await countRows(tx.selectFrom('players').where('user_id', '=', uid)),
            closetItems: await countRows(tx.selectFrom('closet_items').where('user_id', '=', uid)),
            keptPublicTextures: {
              count: await countRows(keptPublic),
              tids: kept.map((row) => row.id),
            },
          },
          ip: actor.ip,
          now: timestamp,
        })
        await deleteAccountData(
          tx,
          { events, removal },
          { uid, actor: eventActor, refund, now: timestamp, admin: { resolverId: actor.uid, ip: actor.ip } },
        )
      })
    },
  }
}
