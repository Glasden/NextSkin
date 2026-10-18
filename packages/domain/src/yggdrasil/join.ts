import { toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import type { Events } from '../events/emit.ts'
import { createPlayerQueries, type PlayerView } from '../players/queries.ts'
import { forbidden } from './errors.ts'
import { normalizeIp, type YggdrasilSessionCache } from './sessions.ts'
import type { Tokens } from './tokens.ts'

export interface JoinInput {
  accessToken: string | null
  selectedProfile: string | null
  serverId: string | null
  ip: string | null
}
export interface HasJoinedInput {
  username: string | null
  serverId: string | null
  ip: string | null
}

export function createSessions(options: {
  db: Kysely<CoreDatabase>
  tokens: Tokens
  cache: YggdrasilSessionCache
  events: Events
  now: () => Date
}) {
  const { db, tokens, cache, events, now } = options
  const players = createPlayerQueries(db)
  return {
    async join(input: JoinInput): Promise<void> {
      const token = await tokens.readToken(input.accessToken, true)
      if (token.player_id === null || token.uuid !== input.selectedProfile)
        throw forbidden('profile_mismatch', token.locale)
      tokens.assertOwned(token)
      tokens.assertNotBanned(token)
      await cache.set(
        input.serverId ?? '',
        { pid: token.player_id, uuid: token.uuid!, ip: normalizeIp(input.ip) },
        120_000,
      )
    },
    async hasJoined(input: HasJoinedInput): Promise<PlayerView | null> {
      const serverId = input.serverId ?? ''
      const session = await cache.get(serverId)
      if (!session || (input.ip !== null && normalizeIp(input.ip) !== session.ip)) return null
      const row = await db
        .selectFrom('players')
        .innerJoin('users', 'users.id', 'players.user_id')
        .select(['players.uuid', 'players.user_id', 'users.role'])
        .where('players.id', '=', session.pid)
        .executeTakeFirst()
      if (!row) return null
      const player = await players.findByUuid(row.uuid)
      if (!player || player.pid !== session.pid || player.name !== input.username) return null
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
