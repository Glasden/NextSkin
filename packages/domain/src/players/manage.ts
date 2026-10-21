import { deletePlayerAuthorizations } from '../oauth/revoke.ts'
import {
  countRows,
  isUniqueViolation,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type IsoTimestamp,
} from '@nextskin/db'
import type { Actor, Player } from '@nextskin/plugin-sdk'
import type { Kysely, Selectable, Transaction } from 'kysely'
import type { PlayersTable } from '@nextskin/db'
import { hasAdminAccess } from '../access/permissions.ts'
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

export interface PlayerChange {
  /** 已经过 validatePlayerName */
  name?: string
  /** null 清空，undefined 不改 */
  skin?: number | null
  cape?: number | null
}

export interface PlayerChangeResult {
  player: Player
  renamed: boolean
  texturesChanged: boolean
}

/**
 * 改名、换材质的主体，用户侧和后台共用（ADR-0036）。row 是调用方在锁内按主人重读的角色。材质要对主人可见、类型要和槽位一致；
 * 用户侧还要求在主人的衣柜里（ADR-0026），后台代为设置不要求。名字的唯一冲突由调用方在事务外转换。
 * 同时改名和换材质时，两个事件用同一个改完的 Player
 */
export async function changePlayer(
  tx: Transaction<CoreDatabase>,
  events: Events,
  row: Selectable<PlayersTable>,
  change: PlayerChange,
  options: { actor: Actor; requireCloset: boolean; now: IsoTimestamp },
): Promise<PlayerChangeResult> {
  const owner = row.user_id
  const renamed = change.name !== undefined && change.name !== row.name
  const skin = change.skin === undefined ? row.skin_texture_id : change.skin
  const cape = change.cape === undefined ? row.cape_texture_id : change.cape
  const texturesChanged = skin !== row.skin_texture_id || cape !== row.cape_texture_id
  const tids = [...new Set([change.skin, change.cape].filter((tid): tid is number => typeof tid === 'number'))].sort(
    (a, b) => a - b,
  )
  // 两个槽都给时，按 tid 升序加锁；错误按整个请求排优先级：不可见，不在衣柜，类型不符
  const textures = []
  for (const tid of tids) {
    const texture = await lockTexture(tx, tid)
    if (!texture || (texture.is_public === 0 && texture.uploader_id !== owner))
      throw new DomainError('texture_not_found')
    textures.push(texture)
  }
  if (options.requireCloset)
    for (const texture of textures) {
      const item = await tx
        .selectFrom('closet_items')
        .select('texture_id')
        .where('user_id', '=', owner)
        .where('texture_id', '=', texture.id)
        .executeTakeFirst()
      if (!item) throw new DomainError('closet_item_not_found')
    }
  for (const texture of textures) {
    if (change.skin === texture.id && texture.type === 'cape')
      throw new DomainError('texture_type_mismatch', { slot: 'skin' })
    if (change.cape === texture.id && texture.type !== 'cape')
      throw new DomainError('texture_type_mismatch', { slot: 'cape' })
  }
  if (!renamed && !texturesChanged) return { player: toPlayer(row), renamed, texturesChanged }
  const nameKey = renamed ? toNameKey(change.name!) : row.name_key
  if (
    renamed &&
    (await tx
      .selectFrom('players')
      .select('id')
      .where('name_key', '=', nameKey)
      .where('id', '!=', row.id)
      .executeTakeFirst())
  )
    throw new DomainError('player_name_taken')
  // 插件运行时落地后，在这里调用 player.rename 拦截器（同一事务）。
  const patch = {
    name: change.name ?? row.name,
    name_key: nameKey,
    skin_texture_id: skin,
    cape_texture_id: cape,
    updated_at: options.now,
  }
  await tx.updateTable('players').set(patch).where('id', '=', row.id).where('user_id', '=', owner).execute()
  const player = toPlayer({ ...row, ...patch })
  if (renamed) await events.emit(tx, 'player.renamed', options.actor, { player, previousName: row.name }, options.now)
  if (texturesChanged)
    await events.emit(
      tx,
      'player.texturesChanged',
      options.actor,
      { player, previous: { skin: row.skin_texture_id, cape: row.cape_texture_id } },
      options.now,
    )
  return { player, renamed, texturesChanged }
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
      'player.maxPerUser',
      'score.perPlayer',
      'auth.requireEmailVerification',
    ])
    return retryOnPlayerUuidRace(db, () =>
      transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
        const limit = values['player.maxPerUser']
        if (
          limit > 0 &&
          !hasAdminAccess(user.role) &&
          (await countRows(tx.selectFrom('players').where('user_id', '=', actor.uid))) >= limit
        )
          throw new DomainError('player_limit_reached', { limit })
        const name = validatePlayerName(input.name, values)
        const now = toIsoTimestamp(clock())
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
        const { player } = await changePlayer(
          tx,
          events,
          row,
          { name, skin: input.skin, cape: input.cape },
          {
            actor: { kind: 'user', uid: actor.uid, role: user.role },
            requireCloset: true,
            now: toIsoTimestamp(clock()),
          },
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
      await deletePlayerAuthorizations(tx, pid)
      const result = await tx
        .deleteFrom('players')
        .where('id', '=', pid)
        .where('user_id', '=', actor.uid)
        .executeTakeFirstOrThrow()
      if (result.numDeletedRows === 0n) throw new DomainError('player_not_found')
      const now = toIsoTimestamp(clock())
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
