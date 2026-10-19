import { toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { Transaction } from 'kysely'
import { audit } from '../audit/write.ts'
import type { Texture } from '../dto.ts'
import { DomainError } from '../errors.ts'
import { changeTexture, lockTexture, type UpdateTextureInput } from '../textures/manage.ts'
import { toTexture } from '../textures/dto.ts'
import { authorize, lockTarget } from './context.ts'
import type { AdminOptions } from './service.ts'
import type { AdminActor } from './types.ts'

export function createAdminTextures(options: AdminOptions) {
  const { db, settings, events, removal, now } = options

  async function managedTexture(tx: Transaction<CoreDatabase>, actor: AdminActor, tid: number) {
    const eventActor = await authorize(tx, actor, 'textures.manage')
    const before = await tx.selectFrom('textures').select('uploader_id').where('id', '=', tid).executeTakeFirst()
    // 上传者 → 材质 → 引用者；上传者可能在等待锁时注销，按材质锁内重读的 uploader_id 判断。
    if (before?.uploader_id !== null && before?.uploader_id !== undefined) await lockTarget(tx, before.uploader_id)
    const row = await lockTexture(tx, tid)
    if (!row) throw new DomainError('texture_not_found')
    if (row.uploader_id === actor.uid) throw new DomainError('admin_own_texture')
    return { eventActor, row }
  }

  // 设置在事务外读：SQLite 只有一个连接，事务内通过 db 读会死锁。
  const readValues = () =>
    settings.read(['texture.nameRegex', 'score.perKbPublic', 'score.perKbPrivate', 'score.refundOnDelete'])
  return {
    async updateTexture(actor: AdminActor, tid: number, input: Omit<UpdateTextureInput, 'public'>): Promise<Texture> {
      if (input.name === undefined && input.type === undefined && input.description === undefined)
        throw new DomainError('invalid_request')
      const values = await readValues()
      return transactionWithRetry(db, async (tx) => {
        const { eventActor, row } = await managedTexture(tx, actor, tid)
        const timestamp = toIsoTimestamp(now())
        const { texture, fields } = await changeTexture(
          tx,
          events,
          removal,
          row,
          {
            name: input.name,
            type: input.type,
            description: input.description,
          },
          {
            actor: eventActor,
            payerUid: null,
            excludeUid: row.uploader_id ?? undefined,
            duplicateExcludeUid: undefined,
            values,
            now: timestamp,
          },
        )
        if (fields.length) {
          const changes: Record<string, { from: string | number; to: string | number }> = {}
          if (fields.includes('name')) changes.name = { from: row.name, to: texture.name }
          if (fields.includes('type')) changes.type = { from: row.type, to: texture.type }
          if (fields.includes('description'))
            changes.description = {
              from: [...(row.description ?? '')].length,
              to: [...(texture.description ?? '')].length,
            }
          await audit(tx, {
            actor: eventActor,
            action: 'texture.update',
            subject: { type: 'texture', id: tid },
            details: { name: texture.name, uploaderId: row.uploader_id, changes },
            ip: actor.ip,
            now: timestamp,
          })
        }
        return texture
      })
    },
    async unpublishTexture(actor: AdminActor, tid: number): Promise<Texture> {
      const values = await readValues()
      return transactionWithRetry(db, async (tx) => {
        const { eventActor, row } = await managedTexture(tx, actor, tid)
        // 已经是私有的什么也不做，上传者注销了也一样；公开、上传者已注销的下架之后就没人看得到、没人付过钱了
        if (row.is_public === 0) return toTexture(row)
        if (row.uploader_id === null) throw new DomainError('texture_uploader_gone')
        const timestamp = toIsoTimestamp(now())
        const { texture, closetItemsRemoved, refunded } = await changeTexture(
          tx,
          events,
          removal,
          row,
          { public: false },
          {
            actor: eventActor,
            payerUid: null,
            excludeUid: row.uploader_id,
            duplicateExcludeUid: undefined,
            values,
            now: timestamp,
          },
        )
        await audit(tx, {
          actor: eventActor,
          action: 'texture.unpublish',
          subject: { type: 'texture', id: tid },
          details: { name: texture.name, uploaderId: row.uploader_id, closetItemsRemoved, refunded },
          ip: actor.ip,
          now: timestamp,
        })
        return texture
      })
    },
  }
}
