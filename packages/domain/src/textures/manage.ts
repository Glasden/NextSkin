import {
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type IsoTimestamp,
  type TextureType,
} from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Texture } from '../dto.ts'
import type { Kysely, Transaction, Updateable } from 'kysely'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import { adjustScore } from '../score/adjust.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { assertPlayerManagementAllowed, lockUser, type UserActor } from '../users/lock.ts'
import { storageFee, textureRows, toTexture, type TextureRow } from './dto.ts'
import type { TextureRemoval } from './removal.ts'
import { validateTextureDescription, validateTextureName } from './validation.ts'

export async function lockTexture(tx: Transaction<CoreDatabase>, tid: number) {
  await tx
    .updateTable('textures')
    .set((eb) => ({ name: eb.ref('name') }))
    .where('id', '=', tid)
    .execute()
  return textureRows(tx).where('textures.id', '=', tid).executeTakeFirst()
}
export interface UpdateTextureInput {
  name?: string
  type?: TextureType
  public?: boolean
  description?: string | null
}
/** 已锁住用户和材质后的修改主体：付款人、清理排除的人、公开查重排除的人分别指定（ADR-0036）。 */
export async function changeTexture(
  tx: Transaction<CoreDatabase>,
  events: Events,
  removal: TextureRemoval,
  row: TextureRow,
  input: UpdateTextureInput,
  options: {
    actor: Actor
    payerUid: number | null
    excludeUid: number | undefined
    duplicateExcludeUid: number | undefined
    values: {
      'texture.nameRegex': string
      'score.perKbPublic': number
      'score.perKbPrivate': number
      'score.refundOnDelete': boolean
    }
    now: IsoTimestamp
  },
) {
  const tid = row.id
  const patch: Updateable<CoreDatabase['textures']> = {}
  const fields: ('name' | 'type' | 'public' | 'description')[] = []
  const { actor: eventActor, now: timestamp, values } = options
  let cleanup = { closetItemsRemoved: 0, refunded: 0 }
  let scoreDelta = 0
  if (input.name !== undefined) {
    const name = validateTextureName(input.name, values['texture.nameRegex'])
    if (name !== row.name) {
      patch.name = name
      fields.push('name')
    }
  }
  if (input.type !== undefined && input.type !== row.type) {
    if (row.type === 'cape' || input.type === 'cape' || (input.type === 'alex' && row.width !== row.height))
      throw new DomainError('texture_type_invalid')
    patch.type = input.type
    fields.push('type')
    await tx
      .updateTable('players')
      .set({ updated_at: timestamp })
      .where((eb) => eb.or([eb('skin_texture_id', '=', tid), eb('cape_texture_id', '=', tid)]))
      .execute()
  }
  if (input.public !== undefined && input.public !== (row.is_public === 1)) {
    if (input.public) {
      await tx
        .updateTable('texture_files')
        .set((eb) => ({ ref_count: eb.ref('ref_count') }))
        // 导入可能有多个旧 hash 指向同一像素；锁整个像素组，与上传锁最小 active 文件的路径互斥。
        .where('pixel_hash', '=', row.pixel_hash)
        .execute()
      let duplicateQuery = tx
        .selectFrom('textures')
        .innerJoin('texture_files', 'texture_files.hash', 'textures.hash')
        .select('textures.id')
        .where('texture_files.pixel_hash', '=', row.pixel_hash)
        .where('textures.is_public', '=', 1)
      if (options.duplicateExcludeUid !== undefined)
        duplicateQuery = duplicateQuery.where((eb) =>
          eb.or([
            eb('textures.uploader_id', '!=', options.duplicateExcludeUid!),
            eb('textures.uploader_id', 'is', null),
          ]),
        )
      const duplicate = await duplicateQuery.orderBy('textures.id').executeTakeFirst()
      if (duplicate) throw new DomainError('texture_duplicate', { tid: duplicate.id })
    }
    if (options.payerUid !== null) {
      const paid = storageFee(row.size_bytes!, values[input.public ? 'score.perKbPublic' : 'score.perKbPrivate'])
      // scoreDelta 表示付款人余额的实际变动；management.visibilityDelta 表示待付差价。
      scoreDelta = row.score_paid - paid
      if (scoreDelta)
        await adjustScore(tx, {
          uid: options.payerUid,
          delta: scoreDelta,
          reason: 'score.reasons.textureVisibilityChanged',
          subject: { type: 'texture', id: tid },
          now: timestamp,
        })
      patch.score_paid = paid
    }
    patch.is_public = input.public ? 1 : 0
    fields.push('public')
    if (!input.public)
      cleanup = await removal.cleanup(tx, row, {
        actor: eventActor,
        excludeUid: options.excludeUid,
        refund: values['score.refundOnDelete'],
        deleting: false,
        now: timestamp,
      })
  }
  if (input.description !== undefined) {
    const description = validateTextureDescription(input.description)
    if (description !== row.description) {
      patch.description = description
      fields.push('description')
    }
  }
  if (!fields.length) return { texture: toTexture(row), scoreDelta: 0, fields, ...cleanup }
  await tx
    .updateTable('textures')
    .set({ ...patch, updated_at: timestamp })
    .where('id', '=', tid)
    .execute()
  const texture = toTexture(await textureRows(tx).where('textures.id', '=', tid).executeTakeFirstOrThrow())
  await events.emit(tx, 'texture.updated', eventActor, { texture, fields }, timestamp)
  return { texture, scoreDelta, fields, ...cleanup }
}
export function createTextureManagement(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  events: Events
  removal: TextureRemoval
  now: () => Date
}) {
  const { db, settings, events, removal, now } = options
  async function owned(tx: Transaction<CoreDatabase>, actor: UserActor, tid: number) {
    const row = await lockTexture(tx, tid)
    if (!row || (row.is_public === 0 && row.uploader_id !== actor.uid)) throw new DomainError('texture_not_found')
    if (row.uploader_id !== actor.uid) throw new DomainError('texture_not_owned')
    return row
  }
  return {
    async update(
      actor: UserActor,
      tid: number,
      input: UpdateTextureInput,
    ): Promise<{ texture: Texture; scoreDelta: number }> {
      const values = await settings.read([
        'auth.requireEmailVerification',
        'texture.nameRegex',
        'score.perKbPublic',
        'score.perKbPrivate',
        'score.refundOnDelete',
      ])
      return transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
        const row = await owned(tx, actor, tid)
        const { texture, scoreDelta } = await changeTexture(tx, events, removal, row, input, {
          actor: { kind: 'user', uid: actor.uid, role: user.role },
          payerUid: actor.uid,
          excludeUid: actor.uid,
          duplicateExcludeUid: actor.uid,
          values,
          now: toIsoTimestamp(now()),
        })
        return { texture, scoreDelta }
      })
    },
    async delete(actor: UserActor, tid: number): Promise<{ refunded: number }> {
      const values = await settings.read(['auth.requireEmailVerification', 'score.refundOnDelete'])
      return transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
        const row = await owned(tx, actor, tid)
        const { refunded } = await removal.remove(tx, row, {
          actor: { kind: 'user', uid: actor.uid, role: user.role },
          refund: values['score.refundOnDelete'],
          now: toIsoTimestamp(now()),
        })
        return { refunded }
      })
    },
  }
}
