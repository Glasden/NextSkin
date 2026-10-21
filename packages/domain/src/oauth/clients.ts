import { randomBytes, randomInt } from 'node:crypto'
import {
  countRows,
  insertReturningId,
  isUniqueViolation,
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  transactionWithRetry,
  writeAuthDate,
  type CoreDatabase,
  type IsoTimestamp,
} from '@nextskin/db'
import type { UserAction } from '@nextskin/plugin-sdk'
import type { Kysely, Selectable, Transaction } from 'kysely'
import { sha256 } from '../auth/auth.ts'
import { DomainError } from '../errors.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { rejectNul } from '../text.ts'
import { assertUserActionAllowed } from '../users/action.ts'
import type { UserActionInterceptor } from '../plugins/system.ts'
import { assertPlayerManagementAllowed, lockUser, type UserActor } from '../users/lock.ts'
import { validateClientRedirectUri } from './redirect-uris.ts'
import { DEVICE_CODE_GRANT_TYPE, readScopes, SHARED_CLIENT_SCOPES } from './scopes.ts'

export type OAuthClientType = 'web' | 'native'
export interface OAuthClientView {
  id: number
  clientId: string
  name: string | null
  type: OAuthClientType
  redirectUris: string[]
  deviceCode: boolean
  disabled: boolean
  createdAt: IsoTimestamp
  authorizedUsers: number
}
type ClientRow = Selectable<CoreDatabase['oauth_clients']>

/** 同意记录和未吊销、未过期的两种令牌，按用户和应用去重；用于两个方向的授权计数。 */
function authorizationPairs(db: Kysely<CoreDatabase>, at: IsoTimestamp) {
  const time = writeAuthDate(db, at)
  return db
    .selectFrom('oauth_consents')
    .select(['client_id', 'user_id'])
    .where('user_id', 'is not', null)
    .union(
      db
        .selectFrom('oauth_access_tokens')
        .select(['client_id', 'user_id'])
        .where('user_id', 'is not', null)
        .where('revoked', 'is', null)
        .where('expires_at', '>', time),
    )
    .union(
      db
        .selectFrom('oauth_refresh_tokens')
        .select(['client_id', 'user_id'])
        .where('user_id', 'is not', null)
        .where('revoked', 'is', null)
        .where('expires_at', '>', time),
    )
}
export function countAuthorizedUsers(db: Kysely<CoreDatabase>, clientId: string, at: IsoTimestamp) {
  return countRows(db.selectFrom(authorizationPairs(db, at).as('authorizations')).where('client_id', '=', clientId))
}
export function countAuthorizedApps(db: Kysely<CoreDatabase>, uid: number, at: IsoTimestamp) {
  return countRows(db.selectFrom(authorizationPairs(db, at).as('authorizations')).where('user_id', '=', uid))
}

export async function oauthClientView(
  db: Kysely<CoreDatabase>,
  row: ClientRow,
  at: IsoTimestamp,
): Promise<OAuthClientView> {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    type: row.token_endpoint_auth_method === 'none' ? 'native' : 'web',
    redirectUris: readScopes(row.redirect_uris),
    deviceCode: readScopes(row.grant_types).includes(DEVICE_CODE_GRANT_TYPE),
    disabled: readAuthBoolean(row.disabled ?? false),
    createdAt: readAuthDate(row.created_at),
    authorizedUsers: await countAuthorizedUsers(db, row.client_id, at),
  }
}

/** device_codes 没有应用外键；必须在删除应用的事务里先清理选择和设备码。用户侧和后台共用。 */
export async function deleteOAuthClientRow(
  tx: Transaction<CoreDatabase>,
  row: Pick<ClientRow, 'id' | 'client_id'>,
): Promise<void> {
  if (!tx.isTransaction) throw new TypeError('删除 OAuth 应用必须在调用方的事务中执行')
  // 先锁住设备码，等进行中的批准提交：批准先改设备码、再写选择，在 PostgreSQL 上先删选择会漏掉它随后写入的那条
  await tx
    .updateTable('device_codes')
    .set((eb) => ({ client_id: eb.ref('client_id') }))
    .where('client_id', '=', row.client_id)
    .execute()
  const codes = tx.selectFrom('device_codes').select('device_code').where('client_id', '=', row.client_id)
  await tx.deleteFrom('device_code_selections').where('device_code', 'in', codes).execute()
  await tx.deleteFrom('device_codes').where('client_id', '=', row.client_id).execute()
  await tx.deleteFrom('oauth_clients').where('id', '=', row.id).execute()
}

function clientName(value: string) {
  const name = rejectNul(value).trim()
  if (
    [...name].length < 1 ||
    [...name].length > 255 ||
    /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name)
  )
    throw new DomainError('oauth_client_name_invalid', { min: 1, max: 255 })
  return name
}
function redirectUris(input: string[], type: OAuthClientType, previous: string[] = []) {
  const uris = [...new Set(input.map((uri) => rejectNul(uri).trim()).filter(Boolean))]
  if (uris.length > 20) throw new DomainError('oauth_redirect_uris_too_many', { max: 20 })
  for (const uri of uris) {
    if (uri.length > 2048) throw new DomainError('oauth_redirect_uri_too_long', { max: 2048 })
    if (!previous.includes(uri)) validateClientRedirectUri(uri, type)
  }
  return uris
}

export function createOAuthClients(options: {
  interceptUserAction: UserActionInterceptor
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  now: () => Date
}) {
  const { db, settings, now, interceptUserAction } = options
  async function owned(tx: Transaction<CoreDatabase>, actor: UserActor, id: number) {
    const row = await tx
      .selectFrom('oauth_clients')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', actor.uid)
      .executeTakeFirst()
    if (!row) throw new DomainError('oauth_client_not_found')
    return row
  }
  async function write<T>(actor: UserActor, action: UserAction, run: (tx: Transaction<CoreDatabase>) => Promise<T>) {
    const values = await settings.read(['auth.requireEmailVerification'])
    // 事务之前调用插件（ADR-0046）；输入的校验仍在锁内、封禁和邮箱验证之后
    await assertUserActionAllowed(interceptUserAction, actor.uid, action)
    return transactionWithRetry(db, async (tx) => {
      const user = await lockUser(tx, actor.uid)
      assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
      return run(tx)
    })
  }
  return {
    async listClients(uid: number): Promise<OAuthClientView[]> {
      const rows = await db
        .selectFrom('oauth_clients')
        .selectAll()
        .where('user_id', '=', uid)
        .orderBy('id', 'desc')
        .execute()
      const at = toIsoTimestamp(now())
      return Promise.all(rows.map((row) => oauthClientView(db, row, at)))
    },
    async createClient(
      actor: UserActor,
      input: { name: string; type: OAuthClientType; redirectUris: string[] },
    ): Promise<{ client: OAuthClientView; clientSecret: string | null }> {
      // PG 的唯一冲突会作废事务；事务外捕获并重新生成 id、重做整笔事务，最多三次。
      for (let attempt = 0; ; attempt++) {
        try {
          return await write(actor, 'oauthClient.create', async (tx) => {
            const name = clientName(input.name)
            if (input.type !== 'web' && input.type !== 'native') throw new DomainError('invalid_request')
            const uris = redirectUris(input.redirectUris, input.type)
            const web = input.type === 'web'
            if (web && uris.length === 0) throw new DomainError('oauth_redirect_uri_required')
            const clientId = Array.from({ length: 32 }, () => String.fromCharCode(97 + randomInt(26))).join('')
            const clientSecret = web ? randomBytes(32).toString('base64url') : null
            const at = toIsoTimestamp(now())
            const timestamp = writeAuthDate(tx, at)
            const grants = web
              ? ['authorization_code', 'refresh_token']
              : [DEVICE_CODE_GRANT_TYPE, 'refresh_token', ...(uris.length ? ['authorization_code'] : [])]
            const id = await insertReturningId(tx, 'oauth_clients', {
              client_id: clientId,
              name,
              user_id: actor.uid,
              disabled: false,
              redirect_uris: JSON.stringify(uris),
              created_at: timestamp,
              updated_at: timestamp,
              client_secret: clientSecret === null ? null : sha256(clientSecret),
              token_endpoint_auth_method: web ? 'client_secret_basic' : 'none',
              require_pkce: !web,
              application_type: input.type,
              grant_types: JSON.stringify(grants),
              response_types: uris.length ? JSON.stringify(['code']) : null,
              ...(web ? {} : { scopes: JSON.stringify(SHARED_CLIENT_SCOPES) }),
            })
            return { client: await oauthClientView(tx, await owned(tx, actor, id), at), clientSecret }
          })
        } catch (error) {
          if (attempt >= 2 || !isUniqueViolation(db, error)) throw error
        }
      }
    },
    async updateClient(
      actor: UserActor,
      id: number,
      input: { name?: string; redirectUris?: string[] },
    ): Promise<OAuthClientView> {
      return write(actor, 'oauthClient.update', async (tx) => {
        const row = await owned(tx, actor, id)
        if (input.name === undefined && input.redirectUris === undefined) throw new DomainError('invalid_request')
        const at = toIsoTimestamp(now())
        const changes: { name?: string; redirect_uris?: string; grant_types?: string; response_types?: string | null } =
          {}
        if (input.name !== undefined) changes.name = clientName(input.name)
        if (input.redirectUris !== undefined) {
          const uris = redirectUris(
            input.redirectUris,
            row.token_endpoint_auth_method === 'none' ? 'native' : 'web',
            readScopes(row.redirect_uris),
          )
          const previous = readScopes(row.grant_types)
          let grants = previous.length ? previous : ['authorization_code']
          // Better Auth 在有授权码时隐含允许刷新；原来能刷新的，去掉授权码之后要显式登记，原来不能的不加
          const refresh = grants.includes('refresh_token') || grants.includes('authorization_code')
          if (uris.length) grants = [...new Set([...grants, 'authorization_code'])]
          else {
            if (!grants.includes(DEVICE_CODE_GRANT_TYPE)) throw new DomainError('oauth_redirect_uri_required')
            grants = grants.filter((grant) => grant !== 'authorization_code')
          }
          changes.redirect_uris = JSON.stringify(uris)
          changes.grant_types = JSON.stringify(refresh ? [...new Set([...grants, 'refresh_token'])] : grants)
          changes.response_types = uris.length ? JSON.stringify(['code']) : null
        }
        await tx
          .updateTable('oauth_clients')
          .set({ ...changes, updated_at: writeAuthDate(tx, at) })
          .where('id', '=', id)
          .execute()
        return oauthClientView(tx, await owned(tx, actor, id), at)
      })
    },
    async resetClientSecret(actor: UserActor, id: number): Promise<{ client: OAuthClientView; clientSecret: string }> {
      return write(actor, 'oauthClient.resetSecret', async (tx) => {
        const row = await owned(tx, actor, id)
        if (row.token_endpoint_auth_method === 'none') throw new DomainError('oauth_client_public')
        const clientSecret = randomBytes(32).toString('base64url')
        const at = toIsoTimestamp(now())
        await tx
          .updateTable('oauth_clients')
          .set({ client_secret: sha256(clientSecret), updated_at: writeAuthDate(tx, at) })
          .where('id', '=', id)
          .execute()
        return { client: await oauthClientView(tx, row, at), clientSecret }
      })
    },
    async deleteClient(actor: UserActor, id: number): Promise<void> {
      await write(actor, 'oauthClient.delete', async (tx) => deleteOAuthClientRow(tx, await owned(tx, actor, id)))
    },
  }
}
