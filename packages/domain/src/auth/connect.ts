import { defineRequestState } from '@better-auth/core/context'
import { parseAccessTokenAuthorization, stripAccessTokenAuthorizationScheme } from '@better-auth/core/oauth2'
import {
  getOAuthProviderState,
  type OAuthExtensionGrantHandler,
  type oauthDeviceAuthorization,
} from '@better-auth/oauth-provider'
import { readAuthBoolean, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api'
import type { Kysely } from 'kysely'
import {
  DEVICE_CODE_GRANT_TYPE,
  JOIN_SCOPE,
  isValidScopeSet,
  OAUTH_SCOPES,
  parsePlayerReference,
  playerReference,
  readScopes,
  SELECT_SCOPE,
  splitScopes,
  YGGDRASIL_SCOPES,
} from '../oauth/scopes.ts'
import { CLIENT_IP_HEADER, sha256 } from './auth.ts'
import type { IssueTokenInterceptor } from '../plugins/system.ts'
import { connectClaims } from './connect-claims.ts'
import { authorizationClient, authorizationError, splitPrompt } from './authorization.ts'

const grantOwner = defineRequestState<{ uid: number; version: number } | null>(() => null)
const userInfoScopes = defineRequestState<string[]>(() => [])
const revokingAccessToken = defineRequestState<{ id: number; refresh_id: number | null } | null>(() => null)
const selectedPlayer = defineRequestState<number | null>(() => null)

/** 选择只活在同意请求里，避免同一用户并行授权时串用角色。 */
export async function consentReferenceId({ scopes }: { scopes: string[] }) {
  if (!scopes.includes(SELECT_SCOPE)) return undefined
  const pid = await selectedPlayer.get()
  if (pid === null) invalidRequest('A player must be selected')
  return playerReference(pid)
}

function invalidTarget(): never {
  throw new APIError('BAD_REQUEST', {
    error: 'invalid_target',
    error_description: 'Resource indicators are not supported',
  })
}

function invalidRequest(description: string): never {
  throw new APIError('BAD_REQUEST', { error: 'invalid_request', error_description: description })
}

function invalidGrant(): never {
  throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Invalid authorization grant' })
}

/** 在 oauth-provider 前拒绝不支持的入口，即使 oauth_query 的签名不对也统一返回 invalid_request。 */
export function oauthQueryGuard() {
  return {
    id: 'nextskin-oauth-query-guard',
    hooks: {
      before: [
        {
          // oauth-provider 会在写会话后续跑授权，早于两步验证。只有同意端点能使用 oauth_query。
          matcher: (ctx) => {
            const settings = (ctx as { authorizeSettings?: { isAuthorize?: boolean } }).authorizeSettings
            // consent 的内部 authorize 仍带着原请求体，它不是另一个接受 oauth_query 的 HTTP 入口。
            if (ctx.path === '/oauth2/authorize' && settings !== undefined && settings.isAuthorize !== true)
              return false
            return (
              ctx.path !== '/oauth2/consent' &&
              ctx.body !== null &&
              typeof ctx.body === 'object' &&
              'oauth_query' in ctx.body
            )
          },
          handler: createAuthMiddleware(() => invalidRequest('oauth_query is not accepted')),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}

/** 消费设备码之后才能读选择，避免批准请求和兑换请求之间串用或遗留选择。 */
export function bindDeviceSelection(plugin: ReturnType<typeof oauthDeviceAuthorization>, db: Kysely<CoreDatabase>) {
  // 这是 Better Auth 1.7.10 未公开的包装点；不能重复注册同名 grant，升级由请求级测试守护。
  const grants = (plugin.options as unknown as { grant: { grants: Record<string, OAuthExtensionGrantHandler> } }).grant
    .grants
  const original = grants[DEVICE_CODE_GRANT_TYPE]!
  grants[DEVICE_CODE_GRANT_TYPE] = (input) =>
    original({
      ...input,
      provider: {
        ...input.provider,
        issueTokens: async (params) => {
          const deviceCode = (input.ctx.body as { device_code: string }).device_code
          try {
            const uid = Number(params.user?.id)
            const user = await db.selectFrom('users').select('role').where('id', '=', uid).executeTakeFirst()
            if (!user || user.role === 'banned') invalidGrant()
            if (!params.scopes.includes(SELECT_SCOPE)) return await input.provider.issueTokens(params)
            const selection = await db
              .selectFrom('device_code_selections')
              .selectAll()
              .where('device_code', '=', deviceCode)
              .executeTakeFirst()
            if (selection?.device_code !== deviceCode || selection.user_id !== uid) invalidGrant()
            const player = await db
              .selectFrom('players')
              .select('id')
              .where('id', '=', selection.player_id)
              .where('user_id', '=', uid)
              .executeTakeFirst()
            if (!player) invalidGrant()
            return await input.provider.issueTokens({ ...params, referenceId: playerReference(player.id) })
          } finally {
            // 设备码已被 consumeOne 删除，选择表没有它的外键，签发失败也要清理。
            const selection = await db
              .selectFrom('device_code_selections')
              .select('device_code')
              .where('device_code', '=', deviceCode)
              .executeTakeFirst()
            if (selection?.device_code === deviceCode)
              await db.deleteFrom('device_code_selections').where('device_code', '=', deviceCode).execute()
          }
        },
      },
    })
  return plugin
}

export function yggdrasilConnect(
  db: Kysely<CoreDatabase>,
  tokensPerUser: () => Promise<number>,
  siteUrl: string,
  requireEmailVerification: () => Promise<boolean>,
  interceptIssueToken?: IssueTokenInterceptor,
) {
  const { picture } = connectClaims(db, siteUrl)
  return {
    id: 'nextskin-yggdrasil-connect',
    // better-call 按主类型解析请求体，设备授权端点却只要 Content-Type 里出现 form 就按表单重读原始请求体，
    // 钩子和端点会看到两套参数。在解析请求体之前统一拒绝歧义类型；不按路径区分，路由会忽略末尾的斜杠。
    onRequest: (request) => {
      const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
      if (
        contentType.includes('application/x-www-form-urlencoded') &&
        contentType.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded'
      )
        return Promise.resolve({
          response: Response.json(
            { error: 'invalid_request', error_description: 'Ambiguous content type' },
            { status: 400 },
          ),
        })
      return Promise.resolve()
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path === '/device/code' ||
            ctx.path?.startsWith('/oauth2/') === true ||
            ctx.path?.startsWith('/admin/oauth2/') === true,
          handler: createAuthMiddleware(async (ctx) => {
            // 钩子早于端点的 schema 校验。JSON 字符串、数组和 null 在这里拒绝：
            // 按对象读它们会抛出带着请求体原文的 TypeError，再被 better-call 写进日志
            if (
              ctx.body !== undefined &&
              (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body))
            )
              invalidRequest('Request body must be an object')
            const body = ctx.body as Record<string, unknown> | undefined
            // 端点的 schema 会去掉 grant_type 两端的空白，这里按同样的值判断
            const grantType = typeof body?.grant_type === 'string' ? body.grant_type.trim() : undefined
            if (ctx.path === '/oauth2/consent' && body?.accept !== false) {
              const session = await getSessionFromCtx(ctx)
              if (session) {
                const user = await db
                  .selectFrom('users')
                  .select(['role', 'email_verified'])
                  .where('id', '=', Number(session.user.id))
                  .executeTakeFirst()
                if (
                  !user ||
                  user.role === 'banned' ||
                  ((await requireEmailVerification()) && !readAuthBoolean(user.email_verified))
                )
                  throw new APIError('FORBIDDEN', {
                    error: 'access_denied',
                    error_description: 'Authorization is not allowed',
                  })
              }
            }
            if (ctx.path === '/oauth2/consent' && body?.accept !== false) {
              // oauth-provider 在插件数组里排在前面，已验签后才写这个状态；不从原始请求体信任申请内容。
              const state = await getOAuthProviderState()
              if (!state?.query) invalidRequest('Missing OAuth query')
              const query = new URLSearchParams(state.query)
              const clientId = query.get('client_id')
              const client = await authorizationClient(db, clientId)
              if (!client || client.client_id !== clientId || readAuthBoolean(client.disabled ?? false))
                throw new APIError('BAD_REQUEST', { error: 'invalid_client', error_description: 'Invalid client' })
              const requested = new Set(splitScopes(query.get('scope')))
              const scopes = splitScopes(typeof body?.scope === 'string' ? body.scope : query.get('scope'))
              const accepted = new Set(scopes)
              if (
                body &&
                'scope' in body &&
                (typeof body.scope !== 'string' ||
                  requested.size !== accepted.size ||
                  [...requested].some((scope) => !accepted.has(scope)))
              )
                throw new APIError('BAD_REQUEST', {
                  error: 'invalid_scope',
                  error_description: 'Partial consent is not supported',
                })
              if (!isValidScopeSet(scopes))
                throw new APIError('BAD_REQUEST', {
                  error: 'invalid_scope',
                  error_description: 'Invalid scope combination',
                })
              const selected = ctx.headers?.get('X-NextSkin-Player')
              if (scopes.includes(SELECT_SCOPE)) {
                if (!selected || !/^[1-9]\d{0,15}$/.test(selected) || !Number.isSafeInteger(Number(selected)))
                  invalidRequest('Invalid player selection')
                const session = await getSessionFromCtx(ctx)
                if (!session) invalidRequest('Invalid player selection')
                // 合法的安全整数也可能超出 PostgreSQL integer 的范围。按用户查，再逐字找 pid，
                // 避免数据库在判断角色不存在之前先抛范围错误，导致请求变成 500。
                const players = await db
                  .selectFrom('players')
                  .select(['id', 'user_id'])
                  .where('user_id', '=', Number(session.user.id))
                  .execute()
                const player = players.find((row) => String(row.id) === selected)
                if (!player || String(player.user_id) !== session.user.id) invalidRequest('Invalid player selection')
                await selectedPlayer.set(player.id)
              } else if (selected !== null && selected !== undefined) invalidRequest('A player was not requested')
            }
            // Better Auth 即使没有登记资源，也接受 userinfo 这个隐式 resource，并签发 JWT 访问令牌。
            // 核心只认数据库里的不透明令牌，所以按键是否存在拒绝，重复参数的最后一个空值也不能绕过。
            if ((ctx.path === '/device/code' || ctx.path === '/oauth2/token') && body && 'resource' in body)
              invalidTarget()
            if (ctx.path === '/device/code' && body && 'user_id' in body) invalidRequest('user_id is not accepted')
            if (ctx.path === '/oauth2/authorize') {
              // 同意后的内部续跑带 authorizeSettings={}，POST 也从 query 读。
              const settings = (ctx as { authorizeSettings?: { isAuthorize?: boolean } }).authorizeSettings
              const external = settings === undefined || settings.isAuthorize === true
              const source = ctx.method === 'POST' && external ? 'body' : 'query'
              const params = (ctx[source] ?? {}) as Record<string, unknown>
              const client = await authorizationClient(db, params.client_id)
              for (const key of [
                'client_id',
                'redirect_uri',
                'scope',
                'prompt',
                'state',
                'response_type',
                'max_age',
                'nonce',
              ])
                if (key in params && typeof params[key] !== 'string')
                  return authorizationError(ctx, params, client, 'invalid_request', 'Parameters must be strings')
              if ('resource' in params) invalidTarget()
              if ('dpop_jkt' in params)
                return authorizationError(ctx, params, client, 'invalid_request', 'DPoP is not supported')
              // 同意页只按 scope 展示权限，不能让 claims 绕过它额外申请邮箱、昵称等声明。
              if ('claims' in params)
                return authorizationError(
                  ctx,
                  params,
                  client,
                  'invalid_request',
                  'The claims parameter is not supported',
                )
              // MySQL 比较会忽略末尾空格，不能让 Better Auth 把查到的另一个标识当成这个应用。
              if (client && client.client_id !== params.client_id)
                return authorizationError(ctx, params, client, 'invalid_client', 'Invalid client')
              const updated = { ...params }
              const prompt = new Set(
                splitPrompt(params.prompt as string | undefined).map((value) =>
                  value === 'create' || value === 'select_account' ? 'login' : value,
                ),
              )
              if ('prompt' in params) updated.prompt = [...prompt].join(' ')
              let effectiveScopes = splitScopes(params.scope as string | undefined)
              if (!effectiveScopes.length) {
                const scopes = client?.scopes != null ? readScopes(client.scopes) : OAUTH_SCOPES
                effectiveScopes = scopes.filter((scope) => !YGGDRASIL_SCOPES.includes(scope))
                updated.scope = effectiveScopes.join(' ')
              }
              if (!isValidScopeSet(effectiveScopes))
                return authorizationError(ctx, params, client, 'invalid_scope', 'Invalid scope combination')
              const session = await getSessionFromCtx(ctx)
              if (session) {
                const user = await db
                  .selectFrom('users')
                  .select(['role', 'email_verified'])
                  .where('id', '=', Number(session.user.id))
                  .executeTakeFirst()
                if (
                  !user ||
                  user.role === 'banned' ||
                  ((await requireEmailVerification()) && !readAuthBoolean(user.email_verified))
                ) {
                  if (!external)
                    throw new APIError('FORBIDDEN', {
                      error: 'access_denied',
                      error_description: 'Authorization is not allowed',
                    })
                  if (prompt.has('none'))
                    return authorizationError(ctx, params, client, 'access_denied', 'Authorization is not allowed')
                  prompt.add('consent')
                  updated.prompt = [...prompt].join(' ')
                }
              }
              // 内部续跑已经处理过同意，不能再次加入 consent。
              if (
                external &&
                (client?.token_endpoint_auth_method === 'none' || effectiveScopes.includes(SELECT_SCOPE))
              ) {
                if (prompt.has('none')) {
                  if (session)
                    return authorizationError(ctx, params, client, 'consent_required', 'End-User consent is required')
                } else {
                  prompt.add('consent')
                  updated.prompt = [...prompt].join(' ')
                }
              }
              return { context: { [source]: updated } }
            }
            if (ctx.path === '/oauth2/token' && body && grantType === 'refresh_token') {
              if (
                'scope' in body &&
                (typeof body.scope !== 'string' ||
                  !isValidScopeSet(splitScopes(body.scope)) ||
                  !splitScopes(body.scope).includes('offline_access'))
              )
                throw new APIError('BAD_REQUEST', {
                  error: 'invalid_scope',
                  error_description: 'Invalid scope combination',
                })
              if (typeof body.refresh_token === 'string') {
                const token = sha256(body.refresh_token)
                const row = await db
                  .selectFrom('oauth_refresh_tokens')
                  .innerJoin('users', 'users.id', 'oauth_refresh_tokens.user_id')
                  .select(['token', 'role', 'users.id', 'oauth_version'])
                  .where('token', '=', token)
                  .executeTakeFirst()
                if (row?.token === token) {
                  if (row.role === 'banned') invalidGrant()
                  await grantOwner.set({ uid: row.id, version: row.oauth_version })
                }
              }
            }
            if (
              ctx.path === '/oauth2/token' &&
              grantType === DEVICE_CODE_GRANT_TYPE &&
              typeof body?.device_code === 'string'
            ) {
              const row = await db
                .selectFrom('device_codes')
                .select(['device_code', 'user_id'])
                .where('device_code', '=', body.device_code)
                .executeTakeFirst()
              if (row?.device_code === body.device_code && row.user_id !== null) {
                const uid = Number(row.user_id)
                if (!Number.isSafeInteger(uid) || String(uid) !== row.user_id) invalidGrant()
                const user = await db
                  .selectFrom('users')
                  .select('oauth_version')
                  .where('id', '=', uid)
                  .executeTakeFirst()
                if (user) await grantOwner.set({ uid, version: user.oauth_version })
              }
            }
            if (ctx.path === '/oauth2/token' && grantType === 'authorization_code' && typeof body?.code === 'string') {
              const identifier = sha256(body.code)
              const row = await db
                .selectFrom('verifications')
                .select(['identifier', 'value'])
                .where('identifier', '=', identifier)
                .executeTakeFirst()
              if (row?.identifier === identifier) {
                let value: { userId?: unknown; sessionId?: unknown }
                try {
                  value = JSON.parse(row.value) as typeof value
                } catch {
                  invalidGrant()
                }
                const uid = Number(value?.userId)
                const sessionId = Number(value?.sessionId)
                if (
                  !Number.isSafeInteger(uid) ||
                  String(uid) !== value?.userId ||
                  !Number.isSafeInteger(sessionId) ||
                  String(sessionId) !== value?.sessionId
                )
                  invalidGrant()
                const user = await db
                  .selectFrom('users')
                  .select(['role', 'oauth_version'])
                  .where('id', '=', uid)
                  .executeTakeFirst()
                if (!user || user.role === 'banned') invalidGrant()
                const session = await db
                  .selectFrom('sessions')
                  .select('id')
                  .where('id', '=', sessionId)
                  .where('user_id', '=', uid)
                  .executeTakeFirst()
                if (!session) invalidGrant()
                await grantOwner.set({ uid, version: user.oauth_version })
              }
            }
            if (ctx.path === '/oauth2/revoke' && typeof body?.token === 'string') {
              const token = sha256(stripAccessTokenAuthorizationScheme(body.token))
              const row = await db
                .selectFrom('oauth_access_tokens')
                .select(['id', 'token', 'refresh_id'])
                .where('token', '=', token)
                .executeTakeFirst()
              if (row?.token === token) await revokingAccessToken.set(row)
            }
            if (ctx.path === '/oauth2/userinfo') {
              // 和 Better Auth 取令牌的顺序一致：请求头解析不出令牌时才用请求体，两处都有时它会拒绝请求。
              const tokenValue =
                parseAccessTokenAuthorization(ctx.headers?.get('authorization'))?.token ?? body?.access_token
              if (typeof tokenValue === 'string' && tokenValue) {
                const token = sha256(tokenValue)
                const row = await db
                  .selectFrom('oauth_access_tokens')
                  .innerJoin('users', 'users.id', 'oauth_access_tokens.user_id')
                  .select(['token', 'role', 'scopes'])
                  .where('token', '=', token)
                  .executeTakeFirst()
                if (row?.token === token) {
                  await userInfoScopes.set(readScopes(row.scopes))
                  if (row.role === 'banned')
                    throw new APIError(
                      'UNAUTHORIZED',
                      { error: 'invalid_token', error_description: 'Invalid access token' },
                      { 'WWW-Authenticate': 'Bearer error="invalid_token", error_description="Invalid access token"' },
                    )
                }
              }
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ['/oauth2/token', '/oauth2/revoke', '/oauth2/userinfo'].includes(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const returned: unknown = ctx.context.returned
            if (isAPIError(returned)) return
            let valid: boolean
            let denialDescription: string | undefined
            try {
              if (ctx.path === '/oauth2/userinfo' && returned && typeof returned === 'object') {
                const claims = { ...returned } as Record<string, unknown>
                for (const key of ['given_name', 'family_name', 'iss', 'iat', 'exp', 'picture']) delete claims[key]
                const avatar = (await userInfoScopes.get()).includes('profile')
                  ? await picture(Number(claims.sub))
                  : undefined
                if (avatar) claims.picture = avatar
                return ctx.json(claims)
              }
              if (ctx.path === '/oauth2/revoke') {
                const row = await revokingAccessToken.get()
                if (
                  row?.refresh_id != null &&
                  !(await db.selectFrom('oauth_access_tokens').select('id').where('id', '=', row.id).executeTakeFirst())
                )
                  await db.deleteFrom('oauth_refresh_tokens').where('id', '=', row.refresh_id).execute()
              }
              if (
                ctx.path !== '/oauth2/token' ||
                !returned ||
                typeof returned !== 'object' ||
                !('access_token' in returned) ||
                typeof returned.access_token !== 'string'
              )
                return
              // SQLite 的单连接在事务里不能再读设置，先读好再锁用户。
              const limit = await tokensPerUser()
              const token = sha256(returned.access_token)
              const issued = await db
                .selectFrom('oauth_access_tokens as issued')
                .leftJoin('users', 'users.id', 'issued.user_id')
                .select([
                  'issued.id',
                  'issued.refresh_id',
                  'issued.token',
                  'issued.user_id',
                  'issued.scopes',
                  'users.role',
                  'users.locale',
                ])
                .where('issued.token', '=', token)
                .executeTakeFirst()
              if (issued?.token !== token || issued.user_id === null) {
                valid = false
              } else {
                const uid = issued.user_id
                // 先在事务外等插件，不能握着 SQLite 写锁发 RPC。
                const decision =
                  interceptIssueToken && readScopes(issued.scopes).includes(JOIN_SCOPE) && issued.role !== null
                    ? await interceptIssueToken(
                        { uid, via: 'oauth' },
                        {
                          actor: { kind: 'user', uid, role: issued.role },
                          locale: issued.locale,
                          ip: ctx.headers?.get(CLIENT_IP_HEADER) ?? null,
                        },
                      )
                    : { action: 'allow' as const }
                if (decision.action !== 'allow') {
                  if (issued.refresh_id !== null)
                    await db.deleteFrom('oauth_refresh_tokens').where('id', '=', issued.refresh_id).execute()
                  else await db.deleteFrom('oauth_access_tokens').where('id', '=', issued.id).execute()
                  valid = false
                  denialDescription =
                    decision.action === 'deny' ? decision.message : 'Token issuance is temporarily unavailable'
                } else {
                  valid = await transactionWithRetry(db, async (tx) => {
                    await tx
                      .updateTable('users')
                      .set((eb) => ({ role: eb.ref('role') }))
                      .where('id', '=', uid)
                      .execute()
                    const current = await tx
                      .selectFrom('oauth_access_tokens')
                      .selectAll()
                      .where('token', '=', token)
                      .executeTakeFirst()
                    if (current?.token !== token) return false
                    const remove = async (row: { id: number; refresh_id: number | null }) => {
                      if (row.refresh_id !== null)
                        await tx.deleteFrom('oauth_refresh_tokens').where('id', '=', row.refresh_id).execute()
                      else await tx.deleteFrom('oauth_access_tokens').where('id', '=', row.id).execute()
                    }
                    const user = await tx
                      .selectFrom('users')
                      .select(['role', 'oauth_version'])
                      .where('id', '=', uid)
                      .executeTakeFirst()
                    const snapshot = await grantOwner.get()
                    if (
                      !user ||
                      user.role === 'banned' ||
                      !snapshot ||
                      snapshot.uid !== current.user_id ||
                      snapshot.version !== user.oauth_version
                    ) {
                      await remove(current)
                      return false
                    }
                    const body = ctx.body as Record<string, string>
                    if (body.grant_type?.trim() === 'refresh_token' && typeof body.refresh_token === 'string') {
                      const oldHash = sha256(body.refresh_token)
                      const old = await tx
                        .selectFrom('oauth_refresh_tokens')
                        .select(['id', 'token'])
                        .where('token', '=', oldHash)
                        .executeTakeFirst()
                      if (old?.token === oldHash)
                        await tx.deleteFrom('oauth_access_tokens').where('refresh_id', '=', old.id).execute()
                    }
                    const pid = parsePlayerReference(current.reference_id)
                    if (
                      pid !== null &&
                      !(await tx
                        .selectFrom('players')
                        .select('id')
                        .where('id', '=', pid)
                        .where('user_id', '=', uid)
                        .executeTakeFirst())
                    ) {
                      await remove(current)
                      return false
                    }
                    const excess = await tx
                      .selectFrom('oauth_access_tokens')
                      .select(['id', 'refresh_id'])
                      .where('user_id', '=', uid)
                      .where('client_id', '=', current.client_id)
                      .orderBy('created_at', 'desc')
                      .orderBy('id', 'desc')
                      .limit(2147483647)
                      .offset(limit)
                      .execute()
                    for (const row of excess) await remove(row)
                    return true
                  })
                }
              }
            } catch {
              console.warn('[auth] oauth_token_check_failed')
              throw new APIError('INTERNAL_SERVER_ERROR', {
                error: 'server_error',
                error_description: 'Token check failed',
              })
            }
            // 清理失败仍由上面的 catch 报 server_error；合法拒绝在 catch 外返回，保留插件文案。
            if (denialDescription !== undefined)
              throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: denialDescription })
            if (!valid) invalidGrant()
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
