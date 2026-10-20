import { deleteClaimedDeviceCodes } from '../oauth/revoke.ts'
import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Transaction } from 'kysely'
import { audit } from '../audit/write.ts'
import type { Events } from '../events/emit.ts'
import type { TextureRow } from '../textures/dto.ts'
import { lockTexture } from '../textures/manage.ts'
import type { TextureRemoval } from '../textures/removal.ts'

/**
 * 管理员删除材质的审计（ADR-0027）：后台删除材质、删除用户连带删掉的材质共用同一种 details。
 * 经由举报删除时带上举报的 id
 */
export async function auditTextureDeletion(
  tx: Transaction<CoreDatabase>,
  input: { actor: Actor; row: TextureRow; ip: string | null; now: IsoTimestamp; reportId?: number },
): Promise<void> {
  const { actor, row, ip, now, reportId } = input
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
    now,
  })
}

/**
 * 删除账号的主体（ADR-0036"删除用户"），用户自删和后台删除用户共用。调用方已经锁住这个用户的行，
 * 并做完各自的检查（自删：核对密码、管理员不能自删、封禁；后台：权限和"能对谁做"）。
 *
 * - 名下角色逐个删除，发 `player.deleted`，不退积分（积分随账号删除）；
 * - 衣柜逐条移出、扣收藏数，发 `closet.itemRemoved`；
 * - 私有材质走删除流程；公开材质留下，由外键把 `uploader_id` 置空（ADR-0025）；
 * - 最后删用户的行（会话、密码、通行密钥、OAuth 应用等由外键级联），发 `user.deleted`。
 *
 * `refund` 是 `score.refundOnDelete`：私有材质还在别人衣柜里时（导入遗留）按实付退给他们。
 * `admin` 表示后台删除：每个角色各记一条 `player.delete`（角色删除以后，UUID 只留在这里）；私有材质照管理员删除处理，
 * 待处理的举报结案、处理人是这个管理员、不发奖励（`report.resolve` 由删除流程写），每个材质记一条 `texture.delete`
 */
export async function deleteAccountData(
  tx: Transaction<CoreDatabase>,
  deps: { events: Events; removal: TextureRemoval },
  input: {
    uid: number
    actor: Actor
    refund: boolean
    now: IsoTimestamp
    admin?: { resolverId: number; ip: string | null }
  },
): Promise<void> {
  const { events, removal } = deps
  const { uid, actor, refund, now, admin } = input
  const players = await tx
    .selectFrom('players')
    .select(['id', 'name', 'uuid', 'score_paid'])
    .where('user_id', '=', uid)
    .orderBy('id')
    .execute()
  for (const player of players) {
    await tx.deleteFrom('players').where('id', '=', player.id).execute()
    await events.emit(tx, 'player.deleted', actor, { pid: player.id, uid, name: player.name, uuid: player.uuid }, now)
    if (admin)
      await audit(tx, {
        actor,
        action: 'player.delete',
        subject: { type: 'user', id: uid },
        details: { pid: player.id, name: player.name, uuid: player.uuid, scorePaid: player.score_paid },
        ip: admin.ip,
        now,
      })
  }
  const items = await tx
    .selectFrom('closet_items')
    .select('texture_id')
    .where('user_id', '=', uid)
    .orderBy('texture_id')
    .execute()
  for (const item of items) {
    await lockTexture(tx, item.texture_id)
    await tx.deleteFrom('closet_items').where('user_id', '=', uid).where('texture_id', '=', item.texture_id).execute()
    await tx
      .updateTable('textures')
      .set((eb) => ({ likes: eb('likes', '-', 1) }))
      .where('id', '=', item.texture_id)
      .execute()
    await events.emit(tx, 'closet.itemRemoved', actor, { uid, tid: item.texture_id }, now)
  }
  const privateTextures = await tx
    .selectFrom('textures')
    .select('id')
    .where('uploader_id', '=', uid)
    .where('is_public', '=', 0)
    .orderBy('id')
    .execute()
  for (const { id } of privateTextures) {
    const texture = await lockTexture(tx, id)
    if (!texture) continue
    await removal.remove(tx, texture, {
      actor,
      refund,
      deletedAccountUid: uid,
      now,
      ...(admin ? { review: { resolverId: admin.resolverId, ip: admin.ip, reward: 0 } } : {}),
    })
    if (admin) await auditTextureDeletion(tx, { actor, row: texture, ip: admin.ip, now })
  }
  await deleteClaimedDeviceCodes(tx, uid)
  await tx.deleteFrom('users').where('id', '=', uid).execute()
  await events.emit(tx, 'user.deleted', actor, { uid }, now)
}
