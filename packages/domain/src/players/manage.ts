import { isUniqueViolation, toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { Player } from '@nextskin/plugin-sdk'
import type { Kysely, Selectable } from 'kysely'
import type { PlayersTable } from '@nextskin/db'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import { adjustScore } from '../score/adjust.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { assertPlayerManagementAllowed, lockUser, type UserActor } from '../users/lock.ts'
import { createPlayer, retryOnPlayerUuidRace, validatePlayerName } from './create.ts'
import { lockTexture } from '../textures/manage.ts'
import { toNameKey } from './queries.ts'

export function toPlayer(row: Selectable<PlayersTable>): Player {
  return {
    pid: row.id,
    uid: row.user_id,
    name: row.name,
    uuid: row.uuid,
    skin: row.skin_texture_id,
    cape: row.cape_texture_id,
    updatedAt: row.updated_at,
  }
}

export function createPlayerManagement(
  db: Kysely<CoreDatabase>,
  settings: ReturnType<typeof createSettingQueries>,
  events: Events,
  clock: () => Date,
) {
  async function create(actor: UserActor, input: { name: string }): Promise<Player> {
    const values = await settings.read([
      'player.nameRule',
      'player.nameRegex',
      'player.nameLength',
      'player.uuidAlgorithm',
      'score.perPlayer',
      'auth.requireEmailVerification',
    ])
    const name = validatePlayerName(input.name, values)
    return retryOnPlayerUuidRace(db, () =>
      transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
        const now = toIsoTimestamp(new Date())
        // 插件运行时落地后，在这里调用 player.create 拦截器（同一事务）。
        const player = await createPlayer(tx, {
          uid: actor.uid,
          name,
          algorithm: values['player.uuidAlgorithm'],
          scorePaid: values['score.perPlayer'],
          now,
        })
        if (values['score.perPlayer'] > 0)
          await adjustScore(tx, {
            uid: actor.uid,
            delta: -values['score.perPlayer'],
            reason: 'score.reasons.playerCreated',
            subject: { type: 'player', id: player.pid },
            now,
          })
        await events.emit(tx, 'player.created', { kind: 'user', uid: actor.uid, role: user.role }, { player }, now)
        return player
      }),
    )
  }

  async function update(
    actor: UserActor,
    pid: number,
    input: { name?: string; skin?: number | null; cape?: number | null },
  ): Promise<Player> {
    const values = await settings.read([
      'player.nameRule',
      'player.nameRegex',
      'player.nameLength',
      'auth.requireEmailVerification',
    ])
    const name = input.name === undefined ? undefined : validatePlayerName(input.name, values)
    try {
      return await transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
        const row = await tx
          .selectFrom('players')
          .selectAll()
          .where('id', '=', pid)
          .where('user_id', '=', actor.uid)
          .executeTakeFirst()
        if (!row) throw new DomainError('player_not_found')
        const renamed = name !== undefined && name !== row.name
        const skin = input.skin === undefined ? row.skin_texture_id : input.skin
        const cape = input.cape === undefined ? row.cape_texture_id : input.cape
        const texturesChanged = skin !== row.skin_texture_id || cape !== row.cape_texture_id
        const tids = [
          ...new Set([input.skin, input.cape].filter((tid): tid is number => typeof tid === 'number')),
        ].sort((a, b) => a - b)
        // 两个槽都给时，按 tid 升序加锁；错误按整个请求排优先级：不可见，不在衣柜，类型不符
        const textures = []
        for (const tid of tids) {
          const texture = await lockTexture(tx, tid)
          if (!texture || (texture.is_public === 0 && texture.uploader_id !== actor.uid))
            throw new DomainError('texture_not_found')
          textures.push(texture)
        }
        for (const texture of textures) {
          const item = await tx
            .selectFrom('closet_items')
            .select('texture_id')
            .where('user_id', '=', actor.uid)
            .where('texture_id', '=', texture.id)
            .executeTakeFirst()
          if (!item) throw new DomainError('closet_item_not_found')
        }
        for (const texture of textures) {
          if (input.skin === texture.id && texture.type === 'cape')
            throw new DomainError('texture_type_mismatch', { slot: 'skin' })
          if (input.cape === texture.id && texture.type !== 'cape')
            throw new DomainError('texture_type_mismatch', { slot: 'cape' })
        }
        if (!renamed && !texturesChanged) return toPlayer(row)
        const nameKey = renamed ? toNameKey(name) : row.name_key
        if (
          renamed &&
          (await tx
            .selectFrom('players')
            .select('id')
            .where('name_key', '=', nameKey)
            .where('id', '!=', pid)
            .executeTakeFirst())
        )
          throw new DomainError('player_name_taken')
        const now = toIsoTimestamp(clock())
        // 插件运行时落地后，在这里调用 player.rename 拦截器（同一事务）。
        const patch = {
          name: name ?? row.name,
          name_key: nameKey,
          skin_texture_id: skin,
          cape_texture_id: cape,
          updated_at: now,
        }
        await tx.updateTable('players').set(patch).where('id', '=', pid).where('user_id', '=', actor.uid).execute()
        const player = toPlayer({ ...row, ...patch })
        const eventActor = { kind: 'user' as const, uid: actor.uid, role: user.role }
        if (renamed) await events.emit(tx, 'player.renamed', eventActor, { player, previousName: row.name }, now)
        if (texturesChanged)
          await events.emit(
            tx,
            'player.texturesChanged',
            eventActor,
            { player, previous: { skin: row.skin_texture_id, cape: row.cape_texture_id } },
            now,
          )
        return player
      })
    } catch (error) {
      // PG 的唯一冲突会使事务失效，必须在事务回滚后转换领域错误。
      if (isUniqueViolation(db, error)) throw new DomainError('player_name_taken')
      throw error
    }
  }

  async function deletePlayer(actor: UserActor, pid: number): Promise<{ refunded: number }> {
    const values = await settings.read(['score.refundOnDelete', 'auth.requireEmailVerification'])
    return transactionWithRetry(db, async (tx) => {
      const user = await lockUser(tx, actor.uid)
      assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
      const row = await tx
        .selectFrom('players')
        .selectAll()
        .where('id', '=', pid)
        .where('user_id', '=', actor.uid)
        .executeTakeFirst()
      if (!row) throw new DomainError('player_not_found')
      const result = await tx
        .deleteFrom('players')
        .where('id', '=', pid)
        .where('user_id', '=', actor.uid)
        .executeTakeFirstOrThrow()
      if (result.numDeletedRows === 0n) throw new DomainError('player_not_found')
      const now = toIsoTimestamp(new Date())
      const refunded = values['score.refundOnDelete'] && row.score_paid > 0 ? row.score_paid : 0
      if (refunded > 0)
        await adjustScore(tx, {
          uid: actor.uid,
          delta: refunded,
          reason: 'score.reasons.playerDeleted',
          subject: { type: 'player', id: pid },
          now,
        })
      await events.emit(
        tx,
        'player.deleted',
        { kind: 'user', uid: actor.uid, role: user.role },
        { pid, uid: actor.uid, name: row.name, uuid: row.uuid },
        now,
      )
      return { refunded }
    })
  }
  return { create, update, delete: deletePlayer }
}
