import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Selectable, Transaction } from 'kysely'
import { claimReport, settleReport } from '../admin/report-resolution.ts'
import type { Events } from '../events/emit.ts'
import { adjustScore } from '../score/adjust.ts'
import type { TextureRow } from './dto.ts'
import type { TextureFiles } from './files.ts'

export function createTextureRemoval(events: Events, files: TextureFiles) {
  async function cleanup(
    tx: Transaction<CoreDatabase>,
    row: TextureRow,
    options: {
      excludeUid?: number
      actor: Actor
      refund: boolean
      deleting: boolean
      now: IsoTimestamp
      /** 删除账号时传入被删的用户：他不退积分（积分随账号删除），也不再为他发头像事件 */
      deletedAccountUid?: number
    },
  ): Promise<{ actorRefund: number; closetItemsRemoved: number; refunded: number }> {
    const { actor, refund, now } = options
    const affected = await tx
      .selectFrom('users')
      .select('users.id')
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('closet_items')
              .select('user_id')
              .whereRef('closet_items.user_id', '=', 'users.id')
              .where('texture_id', '=', row.id),
          ),
          eb.exists(
            eb
              .selectFrom('players')
              .select('user_id')
              .whereRef('players.user_id', '=', 'users.id')
              // 两个槽位都查：从 BS 导入的角色可能把皮肤放在披风槽里（BS 不检查类型和槽位是否匹配）
              .where((eb) => eb.or([eb('skin_texture_id', '=', row.id), eb('cape_texture_id', '=', row.id)])),
          ),
          eb('users.avatar_texture_id', '=', row.id),
        ]),
      )
      .orderBy('users.id')
      .execute()
    let removed = 0,
      actorRefund = 0,
      refunded = 0
    for (const { id: uid } of affected) {
      if (uid === options.excludeUid) continue
      // affected 是预读结果；头像引用者可能在读完后注销，缺失用户不应使操作者的事务失败。
      await tx
        .updateTable('users')
        .set((eb) => ({ role: eb.ref('role') }))
        .where('id', '=', uid)
        .execute()
      const user = await tx.selectFrom('users').select('id').where('id', '=', uid).executeTakeFirst()
      if (!user) continue
      const item = await tx
        .selectFrom('closet_items')
        .select('score_paid')
        .where('user_id', '=', uid)
        .where('texture_id', '=', row.id)
        .executeTakeFirst()
      if (item) {
        await tx.deleteFrom('closet_items').where('user_id', '=', uid).where('texture_id', '=', row.id).execute()
        removed++
        if (refund && uid !== options.deletedAccountUid && item.score_paid > 0) {
          await adjustScore(tx, {
            uid,
            delta: item.score_paid,
            reason: 'score.reasons.closetItemRefunded',
            subject: { type: 'texture', id: row.id },
            now,
          })
          refunded += item.score_paid
          if (actor.kind === 'user' && actor.uid === uid) actorRefund += item.score_paid
        }
        await events.emit(tx, 'closet.itemRemoved', actor, { uid, tid: row.id }, now)
      }
      const players = await tx
        .selectFrom('players')
        .selectAll()
        .where('user_id', '=', uid)
        .where((eb) => eb.or([eb('skin_texture_id', '=', row.id), eb('cape_texture_id', '=', row.id)]))
        .orderBy('id')
        .execute()
      for (const player of players) {
        const skin = player.skin_texture_id === row.id ? null : player.skin_texture_id
        const cape = player.cape_texture_id === row.id ? null : player.cape_texture_id
        await tx
          .updateTable('players')
          .set({ skin_texture_id: skin, cape_texture_id: cape, updated_at: now })
          .where('id', '=', player.id)
          .execute()
        await events.emit(
          tx,
          'player.texturesChanged',
          actor,
          {
            player: {
              pid: player.id,
              uid,
              name: player.name,
              uuid: player.uuid,
              skin,
              cape,
              updatedAt: now,
            },
            previous: { skin: player.skin_texture_id, cape: player.cape_texture_id },
          },
          now,
        )
      }
      const avatar = await tx
        .updateTable('users')
        .set({ avatar_texture_id: null })
        .where('id', '=', uid)
        .where('avatar_texture_id', '=', row.id)
        .executeTakeFirstOrThrow()
      // 删除账号时，被删的用户自己的头像不用再发事件：随后就有 user.deleted
      if (avatar.numUpdatedRows > 0n && uid !== options.deletedAccountUid)
        await events.emit(tx, 'user.profileUpdated', actor, { uid, fields: ['avatar'] }, now)
    }
    if (!options.deleting && removed)
      await tx
        .updateTable('textures')
        .set((eb) => ({ likes: eb('likes', '-', removed) }))
        .where('id', '=', row.id)
        .execute()
    return { actorRefund, closetItemsRemoved: removed, refunded }
  }
  async function remove(
    tx: Transaction<CoreDatabase>,
    row: TextureRow,
    options: {
      actor: Actor
      refund: boolean
      now: IsoTimestamp
      deletedAccountUid?: number
      /** 管理员删除不退上传者存储费，默认保留自删的退款行为。 */
      refundUploader?: boolean
      /**
       * 管理员删除：处理人、IP 和奖励。经由某条举报删除时，那条举报已经由调用方推进了状态（claimed），
       * 在这里和其余待处理的举报一起按举报人 uid 升序结算，不打乱加锁顺序（docs/schema.md）
       */
      review?: {
        resolverId: number
        ip: string | null
        reward: number
        claimed?: Selectable<CoreDatabase['reports']>
      }
    },
  ): Promise<{ refunded: number; resolvedReports: number }> {
    const { actor, refund, now } = options
    let { actorRefund: refunded } = await cleanup(tx, row, { ...options, deleting: true })
    if (
      refund &&
      options.refundUploader !== false &&
      row.uploader_id !== null &&
      row.uploader_id !== options.deletedAccountUid &&
      row.score_paid > 0
    ) {
      await adjustScore(tx, {
        uid: row.uploader_id,
        delta: row.score_paid,
        reason: 'score.reasons.textureDeleted',
        subject: { type: 'texture', id: row.id },
        now,
      })
      if (actor.kind === 'user' && actor.uid === row.uploader_id) refunded += row.score_paid
    }
    const claimed = options.review?.claimed
    const pending = await tx
      .selectFrom('reports')
      .select(['id', 'reporter_id'])
      .where('texture_id', '=', row.id)
      .where('status', '=', 'pending')
      .execute()
    // 举报人为空的排在最后（Infinity - Infinity 是 NaN，接着按 id 比）：四种数据库对 NULL 的排序不同，在这里统一
    const queue = [...pending, ...(claimed ? [claimed] : [])].sort(
      (a, b) => (a.reporter_id ?? Infinity) - (b.reporter_id ?? Infinity) || a.id - b.id,
    )
    let resolvedReports = 0
    for (const { id } of queue) {
      const report =
        id === claimed?.id
          ? claimed
          : await claimReport(tx, id, 'deleteTexture', options.review?.resolverId ?? null, now)
      if (!report) continue
      if (report !== claimed) resolvedReports++
      await settleReport(tx, events, report, {
        actor,
        action: 'deleteTexture',
        reward: options.review?.reward ?? 0,
        ip: options.review?.ip ?? null,
        management: options.review !== undefined,
        deletedAccountUid: options.deletedAccountUid,
        now,
      })
    }
    await tx.deleteFrom('textures').where('id', '=', row.id).execute()
    const lastReference = await files.release(tx, row.hash, now)
    await events.emit(tx, 'texture.deleted', actor, { tid: row.id, hash: row.hash, type: row.type, lastReference }, now)
    return { refunded, resolvedReports }
  }
  return { cleanup, remove }
}
export type TextureRemoval = ReturnType<typeof createTextureRemoval>
