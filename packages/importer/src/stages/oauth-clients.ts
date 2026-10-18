// oauth_clients → oauth_clients（docs/schema.md 的对照表）：Passport 的第三方应用，client_id 不变
import { countRows, writeAuthDate } from '@nextskin/db'
import { sha256 } from '@nextskin/domain/importer'
import { existingUsers, pages, type StageContext } from '../context.ts'
import { bump } from '../report.ts'
import { bsDateTime, toFlag, toInt, toText } from '../values.ts'

export async function importOAuthClients(ctx: StageContext): Promise<void> {
  const { src, tx, report } = ctx
  const stats = report.tables.oauthClients
  const table = ctx.schema.tables.oauth_clients
  stats.source = await countRows(src.selectFrom(table))
  for await (const rows of pages(src, table, 'id', [
    'id',
    'user_id',
    'name',
    'secret',
    'redirect',
    'personal_access_client',
    'password_client',
    'revoked',
    'created_at',
    'updated_at',
  ])) {
    const users = await existingUsers(
      tx,
      rows.map((row) => toInt(row.user_id) ?? 0),
    )
    for (const row of rows) {
      // 这两种授权方式不再支持
      if (toFlag(row.personal_access_client) || toFlag(row.password_client)) {
        bump(stats.skipped, 'unsupported_client')
        continue
      }
      const userId = toInt(row.user_id)
      if (userId !== null && !users.has(userId)) bump(stats.adjusted, 'user_missing')
      // Passport 按 secret 是否为空区分客户端：为空的是公共客户端，换令牌时必须带 PKCE，与 Passport 相同
      const secret = toText(row.secret) ?? ''
      const createdAt = bsDateTime(row.created_at, ctx.timeZone) ?? ctx.now
      const updatedAt = bsDateTime(row.updated_at, ctx.timeZone) ?? createdAt
      await tx
        .insertInto('oauth_clients')
        .values({
          // client_id 原样保留：bigint 的 id 可能超过 2^53，按字符串转，不经过 number
          client_id: toText(row.id)!,
          client_secret: secret ? sha256(secret) : null,
          token_endpoint_auth_method: secret ? 'client_secret_basic' : 'none',
          require_pkce: !secret,
          name: toText(row.name),
          redirect_uris: JSON.stringify(
            (toText(row.redirect) ?? '')
              .split(',')
              .map((uri) => uri.trim())
              .filter(Boolean),
          ),
          grant_types: JSON.stringify(['authorization_code', 'refresh_token']),
          response_types: JSON.stringify(['code']),
          disabled: toFlag(row.revoked),
          user_id: userId !== null && users.has(userId) ? userId : null,
          created_at: writeAuthDate(tx, createdAt),
          updated_at: writeAuthDate(tx, updatedAt),
        })
        .execute()
      stats.imported++
    }
    ctx.advance('oauthClients', rows.length)
  }
}
