import {
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type IsoTimestamp,
} from '@nextskin/db'
import type { Kysely, Selectable } from 'kysely'
import { DomainError } from '../errors.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { assertPlayerManagementAllowed, lockUser } from '../users/lock.ts'
import { isValidScopeSet, SELECT_SCOPE, SHARED_OAUTH_CLIENT_ID, splitScopes, userCodeCandidates } from './scopes.ts'

export interface OAuthClientSummary {
  id: number
  clientId: string
  name: string | null
  shared: boolean
  owner: { uid: number; nickname: string } | null
}

export type DeviceCodeView =
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'claimed' }
  | { status: 'approved' | 'denied'; client: OAuthClientSummary }
  | { status: 'pending'; userCode: string; client: OAuthClientSummary; scopes: string[]; expiresAt: IsoTimestamp }

export async function readClient(db: Kysely<CoreDatabase>, clientId: string | null) {
  if (clientId === null) return undefined
  const row = await db
    .selectFrom('oauth_clients')
    .leftJoin('users', 'users.id', 'oauth_clients.user_id')
    .select(['oauth_clients.id', 'client_id', 'name', 'disabled', 'users.id as owner_id', 'nickname'])
    .where('client_id', '=', clientId)
    .executeTakeFirst()
  // MySQL 的排序规则可能忽略大小写、末尾空格，数据库命中后仍要逐字核对
  if (!row || row.client_id !== clientId) return undefined
  const shared = row.client_id === SHARED_OAUTH_CLIENT_ID
  return {
    disabled: readAuthBoolean(row.disabled ?? false),
    client: {
      id: row.id,
      clientId: row.client_id,
      name: shared ? null : row.name,
      shared,
      owner: shared || row.owner_id === null ? null : { uid: row.owner_id, nickname: row.nickname! },
    } satisfies OAuthClientSummary,
  }
}

type Device = Selectable<CoreDatabase['device_codes']>
const WINDOW_MS = 10 * 60_000

export function createDevices(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  now: () => Date
}) {
  const { db, settings, now } = options
  const failures = new Map<number, { startedAt: number; count: number }>()

  async function find(db: Kysely<CoreDatabase>, uid: number, input: string) {
    const time = now().getTime()
    for (const [id, window] of failures) if (time - window.startedAt >= WINDOW_MS) failures.delete(id)
    const window = failures.get(uid)
    if (window && window.count >= 10)
      throw new DomainError('too_many_requests', {
        retryAfter: Math.ceil((WINDOW_MS - (time - window.startedAt)) / 1000),
      })
    // 在首次 await 前预占一次尝试，避免并发请求一起越过上限。
    const attempt = window ?? { startedAt: time, count: 0 }
    attempt.count++
    failures.set(uid, attempt)
    const code = input.trim()
    if (code.length <= 64) {
      try {
        for (const candidate of userCodeCandidates(code)) {
          const row = await db
            .selectFrom('device_codes')
            .selectAll()
            .where('user_code', '=', candidate)
            .executeTakeFirst()
          if (row?.user_code === candidate) {
            attempt.count--
            return row
          }
        }
      } catch (error) {
        // 查库出错不算猜错，否则数据库抖动几次就把正常用户锁住十分钟
        attempt.count--
        throw error
      }
    }
    // 失败次数不随事务回滚，也不因一次猜中而清零
    return undefined
  }

  async function checked(db: Kysely<CoreDatabase>, uid: number, code: string): Promise<Device> {
    const row = await find(db, uid, code)
    if (!row) throw new DomainError('device_code_invalid')
    if (readAuthDate(row.expires_at) <= toIsoTimestamp(now())) throw new DomainError('device_code_expired')
    if (row.user_id !== String(uid)) throw new DomainError('device_code_claimed')
    if (row.status !== 'pending') throw new DomainError('device_code_processed')
    const client = await readClient(db, row.client_id)
    if (!client || client.disabled) throw new DomainError('device_code_invalid')
    return row
  }

  async function openDevice(uid: number, userCode: string): Promise<DeviceCodeView> {
    let row = await find(db, uid, userCode)
    if (!row) return { status: 'invalid' }
    if (readAuthDate(row.expires_at) <= toIsoTimestamp(now())) return { status: 'expired' }
    const client = await readClient(db, row.client_id)
    if (!client || client.disabled) return { status: 'invalid' }
    if (row.status === 'pending' && row.user_id === null) {
      await db
        .updateTable('device_codes')
        .set({ user_id: String(uid) })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .where('user_id', 'is', null)
        .execute()
      row = await db.selectFrom('device_codes').selectAll().where('id', '=', row.id).executeTakeFirst()
      if (!row) return { status: 'invalid' }
    }
    if (row.user_id !== String(uid)) return { status: 'claimed' }
    if (row.status === 'approved' || row.status === 'denied') return { status: row.status, client: client.client }
    return {
      status: 'pending',
      userCode: row.user_code,
      client: client.client,
      scopes: splitScopes(row.scope),
      expiresAt: readAuthDate(row.expires_at),
    }
  }

  async function approveDevice(uid: number, input: { userCode: string; pid: number | null }): Promise<void> {
    const values = await settings.read(['auth.requireEmailVerification'])
    await transactionWithRetry(db, async (tx) => {
      const user = await lockUser(tx, uid)
      assertPlayerManagementAllowed(user, values['auth.requireEmailVerification'])
      const row = await checked(tx, uid, input.userCode)
      const scopes = splitScopes(row.scope)
      if (!isValidScopeSet(scopes)) throw new DomainError('oauth_scope_invalid')
      if (scopes.includes(SELECT_SCOPE)) {
        if (input.pid === null) throw new DomainError('device_player_required')
        const player = await tx
          .selectFrom('players')
          .select('id')
          .where('id', '=', input.pid)
          .where('user_id', '=', uid)
          .executeTakeFirst()
        if (!player) throw new DomainError('player_not_found')
      }
      const result = await tx
        .updateTable('device_codes')
        .set({ status: 'approved' })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .where('user_id', '=', String(uid))
        .executeTakeFirst()
      if (result.numUpdatedRows !== 1n) throw new DomainError('device_code_processed')
      if (scopes.includes(SELECT_SCOPE)) {
        await tx.deleteFrom('device_code_selections').where('device_code', '=', row.device_code).execute()
        await tx
          .insertInto('device_code_selections')
          .values({
            device_code: row.device_code,
            user_id: uid,
            player_id: input.pid!,
            created_at: toIsoTimestamp(now()),
          })
          .execute()
      }
    })
  }

  async function denyDevice(uid: number, input: { userCode: string }): Promise<void> {
    await transactionWithRetry(db, async (tx) => {
      const row = await checked(tx, uid, input.userCode)
      const result = await tx
        .updateTable('device_codes')
        .set({ status: 'denied' })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .where('user_id', '=', String(uid))
        .executeTakeFirst()
      if (result.numUpdatedRows !== 1n) throw new DomainError('device_code_processed')
      await tx.deleteFrom('device_code_selections').where('device_code', '=', row.device_code).execute()
    })
  }
  return { openDevice, approveDevice, denyDevice }
}
