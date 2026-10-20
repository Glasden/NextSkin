import type { Kysely } from 'kysely'
import { toIsoTimestamp, writeAuthDate } from '../helpers.ts'

/**
 * Yggdrasil Connect 的公用应用（ADR-0037）：发现文档里的 `shared_client_id`，给没有写死 client_id 的启动器用。
 * 没有主人、没有密钥，只走设备码和刷新，不能申请 `email`；名称由界面按语言显示。
 * 不写 id：PostgreSQL 上显式写 id 不推进序列，导入器之后插入的客户端会撞主键。
 * 值照抄 `packages/domain/src/oauth/scopes.ts` 当时的常量：迁移写下的是那一刻的数据，常量以后改了也不跟着变
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = writeAuthDate(db, toIsoTimestamp(new Date()))
  await (db as Kysely<Record<string, Record<string, unknown>>>)
    .insertInto('oauth_clients')
    .values({
      client_id: 'shared',
      client_secret: null,
      disabled: false,
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      require_pkce: true,
      redirect_uris: '[]',
      grant_types: JSON.stringify(['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']),
      response_types: null,
      scopes: JSON.stringify([
        'openid',
        'profile',
        'offline_access',
        'Yggdrasil.PlayerProfiles.Select',
        'Yggdrasil.PlayerProfiles.Read',
        'Yggdrasil.Server.Join',
      ]),
      user_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute()
}
