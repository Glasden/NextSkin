import {
  insertReturningId,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type TextureType,
} from '@nextskin/db'
import type { Texture } from '../dto.ts'
import type { Kysely } from 'kysely'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import { adjustScore } from '../score/adjust.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { assertPlayerManagementAllowed, lockUser, type UserActor } from '../users/lock.ts'
import { storageFee, textureRows, toTexture } from './dto.ts'
import type { TextureFiles } from './files.ts'
import type { ImagePool } from './image-pool.ts'
import type { TextureStorage } from './storage.ts'
import { validateTextureDescription, validateTextureName } from './validation.ts'

class RetryFile extends Error {}
export interface UploadTextureInput {
  bytes: Uint8Array
  name: string
  type: TextureType
  public: boolean
  description?: string | null
}
export function createTextureUpload(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  events: Events
  files: TextureFiles
  storage: TextureStorage
  imagePool: ImagePool
  now: () => Date
  renders: { warm(hash: string, type: TextureType): void }
}) {
  const { db, settings, events, files, storage, imagePool, now } = options
  return async function upload(
    actor: UserActor,
    input: UploadTextureInput,
  ): Promise<{ texture: Texture; charged: number }> {
    const values = await settings.read([
      'texture.nameRegex',
      'auth.requireEmailVerification',
      'score.perKbPublic',
      'score.perKbPrivate',
      'score.perClosetItem',
    ])
    const name = validateTextureName(input.name, values['texture.nameRegex'])
    const description = validateTextureDescription(input.description)
    const user = await db
      .selectFrom('users')
      .select(['role', 'email_verified'])
      .where('id', '=', actor.uid)
      .executeTakeFirst()
    if (!user) throw new DomainError('unauthenticated')
    assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
    const image = await imagePool.processUpload({ bytes: input.bytes, type: input.type })
    // 插件运行时落地后，在这里调用 texture.upload 拦截器；花费在它之后计算。
    const waitBudget = { remainingMs: 1800 }
    for (let attempt = 0; attempt < 4; attempt++) {
      const { file, claimId } = await files.claim(image.pixelHash, waitBudget)
      if (claimId) await storage.write(file.hash, claimId, image.png)
      try {
        const result = await transactionWithRetry(db, async (tx) => {
          const user = await lockUser(tx, actor.uid)
          assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
          const timestamp = toIsoTimestamp(now())
          const updated = claimId
            ? await tx
                .updateTable('texture_files')
                .set({
                  status: 'active',
                  ref_count: 1,
                  pixel_hash: image.pixelHash,
                  width: image.width,
                  height: image.height,
                  size_bytes: image.png.byteLength,
                  status_changed_at: timestamp,
                  delete_attempted_at: null,
                  delete_confirmed_at: null,
                })
                .where('hash', '=', file.hash)
                .where('status', '=', 'pending')
                .where('claim_id', '=', claimId)
                .executeTakeFirstOrThrow()
            : await tx
                .updateTable('texture_files')
                .set((eb) => ({ ref_count: eb('ref_count', '+', 1) }))
                .where('hash', '=', file.hash)
                .where('status', '=', 'active')
                .executeTakeFirstOrThrow()
          if (updated.numUpdatedRows !== 1n) throw new RetryFile()
          const duplicate = await tx
            .selectFrom('textures')
            .innerJoin('texture_files', 'texture_files.hash', 'textures.hash')
            .select('textures.id')
            .where('texture_files.pixel_hash', '=', image.pixelHash)
            .where((eb) => eb.or([eb('textures.is_public', '=', 1), eb('textures.uploader_id', '=', actor.uid)]))
            .orderBy('textures.id')
            .executeTakeFirst()
          if (duplicate) throw new DomainError('texture_duplicate', { tid: duplicate.id })
          const size = claimId ? image.png.byteLength : file.size_bytes!
          const scorePaid = storageFee(size, values[input.public ? 'score.perKbPublic' : 'score.perKbPrivate'])
          const closetPaid = values['score.perClosetItem'],
            charged = scorePaid + closetPaid
          if (charged > 2147483647) {
            const { score } = await tx
              .selectFrom('users')
              .select('score')
              .where('id', '=', actor.uid)
              .executeTakeFirstOrThrow()
            throw new DomainError('score_insufficient', { required: charged, balance: score })
          }
          const tid = await insertReturningId(tx, 'textures', {
            hash: file.hash,
            name,
            type: input.type,
            description,
            uploader_id: actor.uid,
            is_public: input.public ? 1 : 0,
            likes: 1,
            score_paid: scorePaid,
            created_at: timestamp,
            updated_at: timestamp,
          })
          await tx
            .insertInto('closet_items')
            .values({ user_id: actor.uid, texture_id: tid, name, score_paid: closetPaid, created_at: timestamp })
            .execute()
          if (charged > 0)
            await adjustScore(tx, {
              uid: actor.uid,
              delta: -charged,
              reason: 'score.reasons.textureUploaded',
              subject: { type: 'texture', id: tid },
              now: timestamp,
            })
          const texture = toTexture(await textureRows(tx).where('textures.id', '=', tid).executeTakeFirstOrThrow())
          const eventActor = { kind: 'user' as const, uid: actor.uid, role: user.role }
          await events.emit(tx, 'texture.uploaded', eventActor, { texture }, timestamp)
          await events.emit(tx, 'closet.itemAdded', eventActor, { uid: actor.uid, tid }, timestamp)
          return { texture, charged }
        })
        options.renders.warm(result.texture.hash, result.texture.type)
        return result
      } catch (error) {
        if (!(error instanceof RetryFile)) throw error
      }
    }
    throw new DomainError('service_unavailable')
  }
}
