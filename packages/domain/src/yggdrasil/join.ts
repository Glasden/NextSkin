import { toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import type { Events } from '../events/emit.ts'
import { createPlayerQueries, type PlayerView } from '../players/queries.ts'
import { forbidden } from './errors.ts'
import { normalizeIp, sessionCacheKey, type YggdrasilSessionCache } from './sessions.ts'
import type { ServerAdmissionInterceptor } from '../plugins/system.ts'
import type { Tokens } from './tokens.ts'

export interface JoinInput {
  accessToken: string | null
  selectedProfile: string | null
  serverId: string | null
  ip: string | null
  serverKey?: string | null
}
export interface HasJoinedInput {
  username: string | null
  serverId: string | null
  ip: string | null
  serverKey?: string | null
}

export function createSessions(options: {
  db: Kysely<CoreDatabase>
  tokens: Tokens
  cache: YggdrasilSessionCache
  events: Events
  now: () => Date
  interceptServerAdmission?: ServerAdmissionInterceptor
}) {
  const { db, tokens, cache, events, now, interceptServerAdmission } = options
  const players = createPlayerQueries(db)
  async function admitted(
    input: Extract<JoinInput | HasJoinedInput, { serverKey?: string | null }>,
    phase: 'join' | 'hasJoined',
    actor: { uid: number; pid: number; uuid: string; name: string; role: string; locale: string | null },
  ): Promise<boolean> {
    if (input.serverKey == null || !interceptServerAdmission) return true
    const result = await interceptServerAdmission(
      {
        phase,
        serverKey: input.serverKey,
        uid: actor.uid,
        pid: actor.pid,
        playerUuid: actor.uuid,
        playerName: actor.name,
        serverId: input.serverId,
        ip: normalizeIp(input.ip) ?? '',
      },
      { actor: { kind: 'user', uid: actor.uid, role: actor.role }, locale: actor.locale, ip: input.ip },
    )
    return result.action === 'allow'
  }
  return {
    async join(input: JoinInput): Promise<void> {
      const token = await tokens.readSessionToken(input.accessToken)
      if (token.player_id === null || token.uuid !== input.selectedProfile)
        throw forbidden('profile_mismatch', token.locale)
      tokens.assertOwned(token)
      tokens.assertNotBanned(token)
      if (!(await admitted(input, 'join', {
        uid: token.user_id,
        pid: token.player_id,
        uuid: token.uuid!,
        name: token.name!,
        role: token.role,
        locale: token.locale,
      })))
        throw forbidden('token_invalid', token.locale)
      await cache.set(
        sessionCacheKey(input.serverId ?? '', input.serverKey ?? null),
        { pid: token.player_id, uuid: token.uuid!, ip: normalizeIp(input.ip) },
        120_000,
      )
    },
    async hasJoined(input: HasJoinedInput): Promise<PlayerView | null> {
      const serverId = input.serverId ?? ''
      const session = await cache.get(sessionCacheKey(serverId, input.serverKey ?? null))
      if (!session || (input.ip !== null && normalizeIp(input.ip) !== session.ip)) return null
      const row = await db
        .selectFrom('players')
        .innerJoin('users', 'users.id', 'players.user_id')
        .select(['players.uuid', 'players.user_id', 'users.role', 'users.locale'])
        .where('players.id', '=', session.pid)
        .executeTakeFirst()
      if (!row) return null
      const player = await players.findByUuid(row.uuid)
      if (!player || player.pid !== session.pid || player.name !== input.username) return null
      if (!(await admitted(input, 'hasJoined', {
        uid: row.user_id,
        pid: session.pid,
        uuid: player.uuid,
        name: player.name,
        role: row.role,
        locale: row.locale,
      })))
        return null
      if (events.hasSubscribers('yggdrasil.serverJoined'))
        await transactionWithRetry(db, (tx) =>
          events.emit(
            tx,
            'yggdrasil.serverJoined',
            { kind: 'user', uid: row.user_id, role: row.role },
            { pid: session.pid, uuid: player.uuid, serverId },
            toIsoTimestamp(now()),
          ),
        )
      return player
    },
  }
}
