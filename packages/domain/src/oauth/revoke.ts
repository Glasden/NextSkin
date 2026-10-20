import type { CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { playerReference } from './scopes.ts'

function assertTransaction(tx: Kysely<CoreDatabase>) {
  if (!tx.isTransaction) throw new TypeError('吊销 OAuth 授权必须在调用方的事务中执行')
}

/** 先删访问令牌再删刷新令牌，避免级联删除漏计；同意记录不是凭据，保留它 */
export async function deleteOAuthTokensForUser(tx: Kysely<CoreDatabase>, uid: number): Promise<number> {
  assertTransaction(tx)
  const access = await tx.deleteFrom('oauth_access_tokens').where('user_id', '=', uid).executeTakeFirst()
  const refresh = await tx.deleteFrom('oauth_refresh_tokens').where('user_id', '=', uid).executeTakeFirst()
  await tx
    .updateTable('users')
    .set((eb) => ({ oauth_version: eb('oauth_version', '+', 1) }))
    .where('id', '=', uid)
    .execute()
  return Number(access.numDeletedRows + refresh.numDeletedRows)
}

export async function deleteClaimedDeviceCodes(tx: Kysely<CoreDatabase>, uid: number): Promise<void> {
  assertTransaction(tx)
  await tx
    .deleteFrom('device_codes')
    .where('user_id', '=', String(uid))
    .where('status', 'in', ['pending', 'approved'])
    .execute()
  await tx.deleteFrom('device_code_selections').where('user_id', '=', uid).execute()
}

/** reference_id 没有外键，角色删除或换主人时必须显式吊销 */
export async function deletePlayerAuthorizations(tx: Kysely<CoreDatabase>, pid: number): Promise<void> {
  assertTransaction(tx)
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_consents'] as const)
    await tx.deleteFrom(table).where('reference_id', '=', playerReference(pid)).execute()
}

export async function deleteClientAuthorizations(
  tx: Kysely<CoreDatabase>,
  uid: number,
  clientId: string,
): Promise<void> {
  assertTransaction(tx)
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_consents'] as const)
    await tx.deleteFrom(table).where('user_id', '=', uid).where('client_id', '=', clientId).execute()
  // 用子查询按同一条件删除选择，不受数据库参数数量上限影响
  const codes = tx
    .selectFrom('device_codes')
    .select('device_code')
    .where('user_id', '=', String(uid))
    .where('client_id', '=', clientId)
    .where('status', 'in', ['pending', 'approved'])
  await tx.deleteFrom('device_code_selections').where('device_code', 'in', codes).execute()
  await tx
    .deleteFrom('device_codes')
    .where('user_id', '=', String(uid))
    .where('client_id', '=', clientId)
    .where('status', 'in', ['pending', 'approved'])
    .execute()
  await tx
    .updateTable('users')
    .set((eb) => ({ oauth_version: eb('oauth_version', '+', 1) }))
    .where('id', '=', uid)
    .execute()
}
