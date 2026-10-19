import { toIsoTimestamp, transactionWithRetry } from '@nextskin/db'
import { can } from '../access/permissions.ts'
import { audit } from '../audit/write.ts'
import { addClosetItem, removeClosetItem } from '../closet/service.ts'
import { lockTexture } from '../textures/manage.ts'
import { validateTextureName } from '../textures/validation.ts'
import { authorize, manageableTarget } from './context.ts'
import { toAdminClosetItem } from './queries.ts'
import type { AdminOptions } from './service.ts'
import type { AdminActor, AdminClosetItem } from './types.ts'

export function createAdminCloset(options: AdminOptions) {
  const { db, settings, events, now } = options
  return {
    async addClosetItem(
      actor: AdminActor,
      uid: number,
      input: { tid: number; name?: string },
    ): Promise<AdminClosetItem> {
      const values = await settings.read(['texture.nameRegex'])
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'users.manage')
        const owner = await manageableTarget(tx, eventActor, uid)
        const name = input.name === undefined ? undefined : validateTextureName(input.name, values['texture.nameRegex'])
        const timestamp = toIsoTimestamp(now())
        const item = await addClosetItem(
          tx,
          events,
          uid,
          { tid: input.tid, name },
          {
            actor: eventActor,
            paid: 0,
            now: timestamp,
          },
        )
        await audit(tx, {
          actor: eventActor,
          action: 'closet.add',
          subject: { type: 'user', id: uid },
          details: { nickname: owner.nickname, tid: item.tid, name: item.name },
          ip: actor.ip,
          now: timestamp,
        })
        // 响应照衣柜列表的规则：主人自己的私有材质对操作者也是别人的私有材质
        const { uploader_id } = await tx
          .selectFrom('textures')
          .select('uploader_id')
          .where('id', '=', item.tid)
          .executeTakeFirstOrThrow()
        return toAdminClosetItem(
          {
            tid: item.tid,
            name: item.name,
            scorePaid: item.scorePaid,
            addedAt: item.addedAt,
            visibleToOwner: true,
            texture: {
              name: item.textureName,
              type: item.type,
              hash: item.hash,
              scale: item.scale,
              public: item.public,
            },
          },
          item.public || uploader_id === actor.uid || can(eventActor.role, 'textures.manage'),
        )
      })
    },
    async removeClosetItem(actor: AdminActor, uid: number, tid: number): Promise<{ refunded: number }> {
      const values = await settings.read(['score.refundOnDelete'])
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'users.manage')
        const owner = await manageableTarget(tx, eventActor, uid)
        await lockTexture(tx, tid)
        const timestamp = toIsoTimestamp(now())
        const { item, refunded } = await removeClosetItem(tx, events, uid, tid, {
          actor: eventActor,
          refund: values['score.refundOnDelete'],
          now: timestamp,
        })
        await audit(tx, {
          actor: eventActor,
          action: 'closet.remove',
          subject: { type: 'user', id: uid },
          details: { nickname: owner.nickname, tid, name: item.name, refunded },
          ip: actor.ip,
          now: timestamp,
        })
        return { refunded }
      })
    },
  }
}
