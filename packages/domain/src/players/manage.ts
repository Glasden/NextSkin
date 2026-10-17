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
import { toNameKey } from './queries.ts'

function toPlayer(row: Selectable<PlayersTable>): Player {
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

  async function rename(actor: UserActor, pid: number, input: { name: string }): Promise<Player> {
    const values = await settings.read([
      'player.nameRule',
      'player.nameRegex',
      'player.nameLength',
      'auth.requireEmailVerification',
    ])
    const name = validatePlayerName(input.name, values)
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
        if (row.name === name) return toPlayer(row)
        const nameKey = toNameKey(name)
        if (
          await tx
            .selectFrom('players')
            .select('id')
            .where('name_key', '=', nameKey)
            .where('id', '!=', pid)
            .executeTakeFirst()
        )
          throw new DomainError('player_name_taken')
        const now = toIsoTimestamp(new Date())
        // 插件运行时落地后，在这里调用 player.rename 拦截器（同一事务）。
        await tx
          .updateTable('players')
          .set({ name, name_key: nameKey, updated_at: now })
          .where('id', '=', pid)
          .where('user_id', '=', actor.uid)
          .execute()
        const player = toPlayer({ ...row, name, name_key: nameKey, updated_at: now })
        await events.emit(
          tx,
          'player.renamed',
          { kind: 'user', uid: actor.uid, role: user.role },
          { player, previousName: row.name },
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
  return { create, rename, delete: deletePlayer }
}
