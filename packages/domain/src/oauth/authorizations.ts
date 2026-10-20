import {
  readAuthDate,
  toIsoTimestamp,
  transactionWithRetry,
  writeAuthDate,
  type CoreDatabase,
  type IsoTimestamp,
} from '@nextskin/db'
import type { Kysely } from 'kysely'
import { readClient, type OAuthClientSummary } from './devices.ts'
import { OAUTH_SCOPES, parsePlayerReference, readScopes } from './scopes.ts'
import { deleteClientAuthorizations } from './revoke.ts'

export interface OAuthAuthorization {
  id: number
  client: OAuthClientSummary
  scopes: string[]
  players: { pid: number; name: string }[]
  authorizedAt: IsoTimestamp
}

export function createAuthorizations(options: { db: Kysely<CoreDatabase>; now: () => Date }) {
  const { db, now } = options
  async function listAuthorizations(uid: number): Promise<OAuthAuthorization[]> {
    const time = writeAuthDate(db, toIsoTimestamp(now()))
    const consents = await db
      .selectFrom('oauth_consents')
      .select(['client_id', 'scopes', 'updated_at'])
      .where('user_id', '=', uid)
      .execute()
    const tokens = []
    for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens'] as const)
      tokens.push(
        ...(await db
          .selectFrom(table)
          .select(['client_id', 'scopes', 'reference_id', 'created_at'])
          .where('user_id', '=', uid)
          .where('revoked', 'is', null)
          .where('expires_at', '>', time)
          .execute()),
      )
    const players = await db.selectFrom('players').select(['id', 'name']).where('user_id', '=', uid).execute()
    const owned = new Map(players.map((row) => [row.id, row.name]))
    const result: OAuthAuthorization[] = []
    const clientIds = new Set([...consents, ...tokens].map((row) => row.client_id))
    for (const clientId of clientIds) {
      const client = await readClient(db, clientId)
      if (!client) continue
      const grants = [
        ...consents
          .filter((row) => row.client_id === clientId)
          .map((row) => ({ scopes: row.scopes, at: row.updated_at })),
        ...tokens
          .filter((row) => row.client_id === clientId)
          .map((row) => ({ scopes: row.scopes, at: row.created_at })),
      ]
      const scopes = new Set(grants.flatMap((row) => readScopes(row.scopes)))
      const pids = new Set(
        tokens.filter((row) => row.client_id === clientId).map((row) => parsePlayerReference(row.reference_id)),
      )
      result.push({
        id: client.client.id,
        client: client.client,
        scopes: OAUTH_SCOPES.filter((scope) => scopes.has(scope)),
        players: [...pids]
          .filter((pid): pid is number => pid !== null && owned.has(pid))
          .sort((a, b) => a - b)
          .map((pid) => ({ pid, name: owned.get(pid)! })),
        authorizedAt: grants
          .map((row) => readAuthDate(row.at))
          .sort()
          .at(-1)!,
      })
    }
    return result.sort((a, b) => b.authorizedAt.localeCompare(a.authorizedAt) || a.id - b.id)
  }

  async function revokeAuthorization(uid: number, id: number): Promise<void> {
    await transactionWithRetry(db, async (tx) => {
      // 和批准、改密码、转让角色共用用户锁，取消授权不会漏掉刚批准的设备码
      await tx
        .updateTable('users')
        .set((eb) => ({ role: eb.ref('role') }))
        .where('id', '=', uid)
        .execute()
      const client = await tx.selectFrom('oauth_clients').select('client_id').where('id', '=', id).executeTakeFirst()
      if (client) await deleteClientAuthorizations(tx, uid, client.client_id)
    })
  }
  return { listAuthorizations, revokeAuthorization }
}
