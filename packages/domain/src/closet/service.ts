import {
  containsInsensitive,
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
import { lockTexture } from '../textures/manage.ts'
import { validateTextureName } from '../textures/validation.ts'
import { assertPlayerManagementAllowed, lockUser, type UserActor } from '../users/lock.ts'

export interface ClosetItem {
  tid: number
  /** 这一件在衣柜里的名字 */
  name: string
  /** 材质本身的名字 */
  textureName: string
  type: TextureType
  hash: string
  scale: number
  public: boolean
  /** 加入时实付的衣柜费，移出时按它退还 */
  scorePaid: number
  addedAt: IsoTimestamp
}

export function createCloset(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  events: Events
  now: () => Date
}) {
  const { db, settings, events, now } = options
  const rows = (connection = db) =>
    connection
      .selectFrom('closet_items')
      .innerJoin('textures', 'textures.id', 'closet_items.texture_id')
      .innerJoin('texture_files', 'texture_files.hash', 'textures.hash')
      .select([
        'textures.id as tid',
        'closet_items.name',
        'textures.name as textureName',
        'textures.type',
        'textures.hash',
        'textures.is_public',
        'closet_items.score_paid as scorePaid',
        'closet_items.created_at as addedAt',
        'texture_files.width',
        'texture_files.height',
      ])
  function toItem(row: Awaited<ReturnType<ReturnType<typeof rows>['executeTakeFirstOrThrow']>>): ClosetItem {
    const { width, height, is_public, ...item } = row
    // 导入的旧尺寸可能不合法；仍保留可管理的衣柜项，预览按标准倍率回退。
    return { ...item, public: is_public === 1, scale: textureScaleOrNull(item.type, width, height) ?? 1 }
  }
  async function find(connection: Kysely<CoreDatabase>, uid: number, tid: number) {
    const row = await rows(connection).where('user_id', '=', uid).where('texture_id', '=', tid).executeTakeFirst()
    if (!row) throw new DomainError('closet_item_not_found')
    return toItem(row)
  }
  return {
    async list(
      uid: number,
      input: { type: 'skin' | 'cape'; q?: string; page: number; perPage?: number },
    ): Promise<{ items: ClosetItem[]; total: number }> {
      const perPage = Math.max(1, Math.min(60, Math.trunc(input.perPage ?? 20)))
      const page = Math.max(1, Math.trunc(input.page))
      let query = rows()
        .where('user_id', '=', uid)
        .where('textures.type', 'in', input.type === 'skin' ? ['steve', 'alex'] : ['cape'])
        .where((eb) => eb.or([eb('textures.is_public', '=', 1), eb('textures.uploader_id', '=', uid)]))
      const q = input.q?.trim()
      if (q) query = query.where(containsInsensitive('closet_items.name', q))
      const total = await countRows(query.clearSelect())
      const found = await query
        .orderBy('closet_items.created_at', 'desc')
        .orderBy('texture_id', 'desc')
        .limit(perPage)
        .offset((page - 1) * perPage)
        .execute()
      return { items: found.map(toItem), total }
    },
    async add(actor: UserActor, input: { tid: number; name?: string }): Promise<ClosetItem> {
      const values = await settings.read(['texture.nameRegex', 'score.perClosetItem'])
      const name = input.name === undefined ? undefined : validateTextureName(input.name, values['texture.nameRegex'])
      return transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        assertPlayerManagementAllowed(user, false)
        // 插件运行时落地后，在这里调用 closet.add 拦截器（同一事务）。
        const updated = await tx
          .updateTable('textures')
          .set((eb) => ({ likes: eb('likes', '+', 1) }))
          .where('id', '=', input.tid)
          .where((eb) => eb.or([eb('is_public', '=', 1), eb('uploader_id', '=', actor.uid)]))
          .executeTakeFirstOrThrow()
        if (updated.numUpdatedRows === 0n) throw new DomainError('texture_not_found')
        const texture = await tx
          .selectFrom('textures')
          .select('name')
          .where('id', '=', input.tid)
          .executeTakeFirstOrThrow()
        const timestamp = toIsoTimestamp(now())
        const paid = values['score.perClosetItem']
        if (
          !(await insertOrIgnore(
            tx,
            'closet_items',
            {
              user_id: actor.uid,
              texture_id: input.tid,
              name: name ?? texture.name,
              score_paid: paid,
              created_at: timestamp,
            },
            ['user_id', 'texture_id'],
          ))
        )
          throw new DomainError('closet_item_exists')
        if (paid > 0)
          await adjustScore(tx, {
            uid: actor.uid,
            delta: -paid,
            reason: 'score.reasons.closetItemAdded',
            subject: { type: 'texture', id: input.tid },
            now: timestamp,
          })
        await events.emit(
          tx,
          'closet.itemAdded',
          { kind: 'user', uid: actor.uid, role: user.role },
          { uid: actor.uid, tid: input.tid },
          timestamp,
        )
        return find(tx, actor.uid, input.tid)
      })
    },
    async rename(actor: UserActor, tid: number, input: { name: string }): Promise<ClosetItem> {
      const values = await settings.read(['texture.nameRegex'])
      const name = validateTextureName(input.name, values['texture.nameRegex'])
      return transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        assertPlayerManagementAllowed(user, false)
        await lockTexture(tx, tid)
        await find(tx, actor.uid, tid)
        await tx
          .updateTable('closet_items')
          .set({ name })
          .where('user_id', '=', actor.uid)
          .where('texture_id', '=', tid)
          .execute()
        return find(tx, actor.uid, tid)
      })
    },
    async remove(actor: UserActor, tid: number): Promise<{ refunded: number }> {
      const values = await settings.read(['score.refundOnDelete'])
      return transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        assertPlayerManagementAllowed(user, false)
        await lockTexture(tx, tid)
        const item = await find(tx, actor.uid, tid)
        await tx.deleteFrom('closet_items').where('user_id', '=', actor.uid).where('texture_id', '=', tid).execute()
        await tx
          .updateTable('textures')
          .set((eb) => ({ likes: eb('likes', '-', 1) }))
          .where('id', '=', tid)
          .execute()
        const timestamp = toIsoTimestamp(now())
        const eventActor = { kind: 'user' as const, uid: actor.uid, role: user.role }
        const refunded = values['score.refundOnDelete'] ? item.scorePaid : 0
        if (refunded > 0)
          await adjustScore(tx, {
            uid: actor.uid,
            delta: refunded,
            reason: 'score.reasons.closetItemRemoved',
            subject: { type: 'texture', id: tid },
            now: timestamp,
          })
        const players = await tx
          .selectFrom('players')
          .selectAll()
          .where('user_id', '=', actor.uid)
          // 两个槽都清理，兼容 BS 导入的类型错配。
          .where((eb) => eb.or([eb('skin_texture_id', '=', tid), eb('cape_texture_id', '=', tid)]))
          .orderBy('id')
          .execute()
        for (const row of players) {
          const skin = row.skin_texture_id === tid ? null : row.skin_texture_id
          const cape = row.cape_texture_id === tid ? null : row.cape_texture_id
          await tx
            .updateTable('players')
            .set({ skin_texture_id: skin, cape_texture_id: cape, updated_at: timestamp })
            .where('id', '=', row.id)
            .execute()
          await events.emit(
            tx,
            'player.texturesChanged',
            eventActor,
            {
              player: { pid: row.id, uid: actor.uid, name: row.name, uuid: row.uuid, skin, cape, updatedAt: timestamp },
              previous: { skin: row.skin_texture_id, cape: row.cape_texture_id },
            },
            timestamp,
          )
        }
        await events.emit(tx, 'closet.itemRemoved', eventActor, { uid: actor.uid, tid }, timestamp)
        return { refunded }
      })
    },
  }
}
