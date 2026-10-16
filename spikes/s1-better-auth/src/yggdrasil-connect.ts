/**
 * Yggdrasil Connect 在 Better Auth 上的实现草案。
 *
 * 规范：https://github.com/yushijinhun/authlib-injector/issues/268
 * 要点：
 * - 三个自定义 scope 及其组合规则，所有入口都要校验（authorize GET/POST、consent 的 scope 子集、
 *   device/code、refresh 的 scope 参数）；
 * - 申请 PlayerProfiles.Select 时，用户每次授权都要选择角色，访问令牌绑定到该角色，
 *   ID 令牌和 userinfo 带 selectedProfile；
 * - 授权码流和设备代码流都要支持；
 * - 会话服务器（join）要能校验访问令牌、取出绑定的角色和 scope。
 *
 * 绑定方式：把所选角色编码成 Better Auth 的 consent referenceId（`player:<pid>`）。
 * referenceId 会随不透明访问令牌、刷新令牌一起保存，claims 扩展在签发和内省时都能拿到它。
 *
 * 角色选择发生在哪里（这是审核后的修订版本）：
 * - 授权码流：在同意页上选择。同意请求通过 `x-ygg-profile` 请求头带上所选角色，
 *   consent 的 before 钩子在同一个请求里校验并写入 session，随后 Better Auth 在同一请求内
 *   计算 referenceId。申请 Select 时强制 prompt=consent，所以每次授权都会经过同意页。
 *   早先用 postLogin 页面 + session 字段保存选择的做法，会让同一用户并行的两个授权流程互相串用选择。
 * - 设备流：按设备码（随机的 device_code 字符串，而不是会被 SQLite 复用的自增 id）记录选择，
 *   只允许在待批准状态下由认领者选择或更改，兑换后删除。
 */
import {
  DEVICE_CODE_GRANT_TYPE,
  oauthDeviceAuthorization,
  type OAuthProviderExtension,
  verifyOAuthQueryParams,
} from '@better-auth/oauth-provider'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, sessionMiddleware } from 'better-auth/api'
import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import * as z from 'zod'

export const SCOPE = {
  select: 'Yggdrasil.PlayerProfiles.Select',
  read: 'Yggdrasil.PlayerProfiles.Read',
  join: 'Yggdrasil.Server.Join',
} as const

export const OAUTH_SCOPES = ['openid', 'profile', 'offline_access', SCOPE.select, SCOPE.read, SCOPE.join]

/** 选择角色用的请求头。同意页提交时带上所选角色的 pid。 */
export const PROFILE_HEADER = 'x-ygg-profile'

/** 规范里的 scope 组合规则；返回错误描述，合法时返回 null。 */
export function checkYggdrasilScopes(scopes: readonly string[]): string | null {
  const hasYggdrasil = scopes.some((scope) => scope.startsWith('Yggdrasil.'))
  if (hasYggdrasil && !scopes.includes('openid')) return 'Yggdrasil scopes require openid'
  if (scopes.includes(SCOPE.select) && scopes.includes(SCOPE.read))
    return `${SCOPE.select} and ${SCOPE.read} cannot be requested together`
  if (scopes.includes(SCOPE.join) && !scopes.includes(SCOPE.select)) return `${SCOPE.join} requires ${SCOPE.select}`
  return null
}

const REFERENCE_PREFIX = 'player:'
const toReference = (pid: number) => `${REFERENCE_PREFIX}${pid}`
function fromReference(referenceId: string | undefined | null): number | null {
  if (!referenceId?.startsWith(REFERENCE_PREFIX)) return null
  const pid = Number(referenceId.slice(REFERENCE_PREFIX.length))
  return Number.isInteger(pid) ? pid : null
}

interface PlayerRow {
  pid: number
  uid: number
  name: string
  uuid: string
}
const serializeProfile = (player: PlayerRow) => ({ id: player.uuid, name: player.name })

async function findOwnedPlayer(db: Kysely<any>, pid: number, uid: number): Promise<PlayerRow | null> {
  const row = await db.selectFrom('players').selectAll().where('pid', '=', pid).executeTakeFirst()
  return row && Number(row.uid) === uid ? (row as PlayerRow) : null
}

async function listProfiles(db: Kysely<any>, uid: number) {
  const rows = await db.selectFrom('players').selectAll().where('uid', '=', uid).orderBy('pid').execute()
  return rows.map((row) => serializeProfile(row as PlayerRow))
}

const parseScopes = (value: unknown): string[] =>
  typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : Array.isArray(value) ? value.map(String) : []

const scopeError = (description: string) =>
  new APIError('BAD_REQUEST', { error: 'invalid_scope', error_description: description })

export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url')

/** 访问令牌和刷新令牌在库里以 sha256 存储，会话服务器用同样的方式查找。 */
export const storeTokens = { hash: async (token: string) => sha256(token) }

/** 扩展：claims 与发现文档字段。所有 claims 都会重新校验角色归属。 */
export function yggdrasilClaimsExtension(db: Kysely<any>, sharedClientId: () => string): OAuthProviderExtension {
  async function selectedProfile(referenceId: string | undefined, uid: number) {
    const pid = fromReference(referenceId)
    const player = pid === null ? null : await findOwnedPlayer(db, pid, uid)
    return player ? serializeProfile(player) : undefined
  }

  return {
    metadata: () => ({ shared_client_id: sharedClientId() }),
    claims: {
      idToken: async ({ user, scopes, referenceId }) => {
        if (!user) return {}
        const claims: Record<string, unknown> = {}
        if (scopes.includes(SCOPE.select)) {
          const profile = await selectedProfile(referenceId, Number(user.id))
          // 规范要求：申请了 Select 就必须有 selectedProfile。拿不到说明绑定丢了，宁可失败。
          if (!profile) throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'no profile bound' })
          claims.selectedProfile = profile
        }
        if (scopes.includes(SCOPE.read)) claims.availableProfiles = await listProfiles(db, Number(user.id))
        return claims
      },
      accessToken: async ({ user, scopes, referenceId }) => {
        if (!user || !scopes.includes(SCOPE.select)) return {}
        const profile = await selectedProfile(referenceId, Number(user.id))
        return profile ? { selectedProfile: profile } : {}
      },
      // 规范：userinfo 是 ID 令牌声明的超集
      userInfo: async ({ user, scopes, jwt }) => {
        const claims: Record<string, unknown> = {}
        if (jwt.selectedProfile) claims.selectedProfile = jwt.selectedProfile
        if (scopes.includes(SCOPE.read)) claims.availableProfiles = await listProfiles(db, Number(user.id))
        return claims
      },
    },
  }
}

// ---------------------------------------------------------------- 设备流

interface DeviceRecord {
  id: string | number
  deviceCode: string
  userCode: string
  userId: string | number | null
  status: string
  scope: string | null
  expiresAt: string | Date
}

/** 与 Better Auth 一致的 user code 查找：先按原样，查不到再按规范化后的值查。 */
async function findDeviceByUserCode(db: Kysely<any>, userCode: string): Promise<DeviceRecord | undefined> {
  const exact = await db.selectFrom('deviceCode').selectAll().where('userCode', '=', userCode).executeTakeFirst()
  if (exact) return exact as DeviceRecord
  const normalized = userCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  if (normalized === userCode) return undefined
  return (await db.selectFrom('deviceCode').selectAll().where('userCode', '=', normalized).executeTakeFirst()) as
    | DeviceRecord
    | undefined
}

const isExpired = (record: DeviceRecord) => new Date(record.expiresAt).getTime() <= Date.now()

/**
 * 包装 Better Auth 自带的 device_code grant，在签发令牌时补上 referenceId。
 * 上游的 exchangeOAuthDeviceCode 调用 provider.issueTokens 时没有传 referenceId（1.7.10）。
 */
export function yggdrasilDeviceAuthorization(db: Kysely<any>) {
  const plugin = oauthDeviceAuthorization({ verificationUri: '/device' })
  // 运行时 grant 对象同时也是一个 OAuthProviderExtension（带 grants 字段），但公开类型里没有声明。
  // 这是本方案唯一依赖未公开结构的地方，升级 Better Auth 时由 spike 场景测试兜底。
  const grant = plugin.options.grant as (typeof plugin.options.grant & OAuthProviderExtension) | undefined
  if (!grant?.grants) throw new Error('oauthDeviceAuthorization 的内部结构变了，需要重新评估这个包装')
  const original = grant.grants[DEVICE_CODE_GRANT_TYPE]!
  grant.grants[DEVICE_CODE_GRANT_TYPE] = async (input) => {
    const deviceCode = (input.ctx.body as Record<string, unknown> | undefined)?.device_code
    let referenceId: string | undefined
    if (typeof deviceCode === 'string') {
      const record = (await db.selectFrom('deviceCode').selectAll().where('deviceCode', '=', deviceCode).executeTakeFirst()) as
        | DeviceRecord
        | undefined
      if (record?.userId != null) {
        const selection = await db
          .selectFrom('yggDeviceSelection')
          .select('pid')
          .where('deviceCode', '=', deviceCode)
          .where('userId', '=', String(record.userId))
          .executeTakeFirst()
        if (selection) referenceId = toReference(Number(selection.pid))
      }
    }
    const response = await original({
      ...input,
      provider: { ...input.provider, issueTokens: (params) => input.provider.issueTokens({ ...params, referenceId }) },
    })
    // 设备码已被兑换：选择记录随之作废
    if (typeof deviceCode === 'string') await db.deleteFrom('yggDeviceSelection').where('deviceCode', '=', deviceCode).execute()
    return response
  }
  return plugin
}

// ---------------------------------------------------------------- 插件

/** 当前请求是否是外部发起的 authorize（而不是同意/继续之后 Better Auth 的内部续跑）。 */
function isExternalAuthorize(ctx: { request?: Request }) {
  if (!ctx.request) return true
  return new URL(ctx.request.url).pathname.endsWith('/oauth2/authorize')
}

export function yggdrasilConnect(db: Kysely<any>, publicClientIds: () => Promise<Set<string>>, secret: string) {
  return {
    id: 'yggdrasil-connect',
    schema: {
      session: {
        fields: { yggSelectedPid: { type: 'number', required: false, input: false } },
      },
      yggDeviceSelection: {
        fields: {
          deviceCode: { type: 'string', required: true, unique: true },
          userId: { type: 'string', required: true },
          pid: { type: 'number', required: true },
        },
      },
    },
    endpoints: {
      /** 设备流的批准页面调用：在批准前为这个 user_code 选择角色。 */
      yggDeviceSelectProfile: createAuthEndpoint(
        '/ygg/device/select-profile',
        {
          method: 'POST',
          body: z.object({ userCode: z.string(), pid: z.number().int() }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const { user } = ctx.context.session
          const record = await findDeviceByUserCode(db, ctx.body.userCode)
          // GET /device 会把待批准的设备码绑定到当前用户；只能为自己认领、仍在等待批准的设备码选角色
          if (!record || String(record.userId) !== String(user.id))
            throw new APIError('FORBIDDEN', { message: 'device code not claimed by you' })
          if (record.status !== 'pending' || isExpired(record))
            throw new APIError('BAD_REQUEST', { message: 'device code is no longer pending' })
          if (!(await findOwnedPlayer(db, ctx.body.pid, Number(user.id))))
            throw new APIError('FORBIDDEN', { message: 'not your player' })
          await db.deleteFrom('yggDeviceSelection').where('deviceCode', '=', record.deviceCode).execute()
          await db
            .insertInto('yggDeviceSelection')
            .values({ deviceCode: record.deviceCode, userId: String(user.id), pid: ctx.body.pid })
            .execute()
          return ctx.json({ ok: true })
        },
      ),
    },
    hooks: {
      before: [
        {
          // authorize（GET 和 POST 表单两种形式）
          matcher: (ctx) => ctx.path === '/oauth2/authorize',
          handler: createAuthMiddleware(async (ctx) => {
            if (!isExternalAuthorize(ctx)) return
            const form = ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, unknown>) : {}
            const params = { ...(ctx.query ?? {}), ...form } as Record<string, unknown>
            const scopes = parseScopes(params.scope)
            const problem = checkYggdrasilScopes(scopes)
            if (problem) throw scopeError(problem)
            // 申请 Select 时每次都要选角色；公共客户端每次都要征求同意（规范建议）
            const mustConsent = scopes.includes(SCOPE.select) || (await publicClientIds()).has(String(params.client_id))
            if (!mustConsent) return
            const prompts = parseScopes(params.prompt)
            if (prompts.includes('none'))
              throw new APIError('BAD_REQUEST', { error: 'consent_required', error_description: 'interaction is required' })
            const prompt = [...new Set([...prompts, 'consent'])].join(' ')
            return {
              context: {
                query: ctx.query ? { ...ctx.query, prompt } : ctx.query,
                body: Object.keys(form).length ? { ...form, prompt } : ctx.body,
              },
            }
          }),
        },
        {
          // 同意：校验最终接受的 scope；申请 Select 时在同一个请求里绑定所选角色
          matcher: (ctx) => ctx.path === '/oauth2/consent',
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as Record<string, unknown>
            if (body.accept !== true || typeof body.oauth_query !== 'string') return
            if (!(await verifyOAuthQueryParams(body.oauth_query, secret))) return // 交给 Better Auth 拒绝
            const query = new URLSearchParams(body.oauth_query)
            const scopes = body.scope !== undefined ? parseScopes(body.scope) : parseScopes(query.get('scope'))
            const problem = checkYggdrasilScopes(scopes)
            if (problem) throw scopeError(problem)
            const session = await getSessionFromCtx(ctx)
            if (!session) return
            let pid: number | null = null
            if (scopes.includes(SCOPE.select)) {
              pid = Number(ctx.headers?.get(PROFILE_HEADER))
              if (!Number.isInteger(pid) || !(await findOwnedPlayer(db, pid, Number(session.user.id))))
                throw new APIError('BAD_REQUEST', { error: 'invalid_request', error_description: 'select one of your profiles' })
            }
            // 写库，同时更新本请求里缓存的 session 对象：随后计算 referenceId 时读的就是它
            await ctx.context.internalAdapter.updateSession(session.session.token, { yggSelectedPid: pid })
            ;(session.session as Record<string, unknown>).yggSelectedPid = pid
          }),
        },
        {
          // 刷新令牌时缩小 scope，也必须满足组合规则
          matcher: (ctx) => ctx.path === '/oauth2/token',
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as Record<string, unknown>
            if (body.grant_type !== 'refresh_token' || body.scope === undefined) return
            const problem = checkYggdrasilScopes(parseScopes(body.scope))
            if (problem) throw scopeError(problem)
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/device/code',
          handler: createAuthMiddleware(async (ctx) => {
            const problem = checkYggdrasilScopes(parseScopes(ctx.body?.scope))
            if (problem) throw scopeError(problem)
          }),
        },
        {
          // 批准前必须已经为这个设备码选好角色（按与 Better Auth 相同的规则查找 user code）
          matcher: (ctx) => ctx.path === '/device/approve',
          handler: createAuthMiddleware(async (ctx) => {
            const record = await findDeviceByUserCode(db, String(ctx.body?.userCode ?? ''))
            if (!record || !parseScopes(record.scope).includes(SCOPE.select)) return
            const selection = await db
              .selectFrom('yggDeviceSelection')
              .select('pid')
              .where('deviceCode', '=', record.deviceCode)
              .where('userId', '=', String(record.userId))
              .executeTakeFirst()
            if (!selection) throw new APIError('BAD_REQUEST', { message: 'select a profile before approving' })
          }),
        },
      ],
      after: [
        {
          // 拒绝之后清理选择记录
          matcher: (ctx) => ctx.path === '/device/deny',
          handler: createAuthMiddleware(async (ctx) => {
            const record = await findDeviceByUserCode(db, String(ctx.body?.userCode ?? ''))
            if (record) await db.deleteFrom('yggDeviceSelection').where('deviceCode', '=', record.deviceCode).execute()
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}

/** consent 的 referenceId：申请 Select 时就是同一请求里刚写入的角色。 */
export function yggdrasilConsentReference() {
  return {
    // 不需要 postLogin 页面：角色在同意页上选择
    page: '/oauth/consent',
    shouldRedirect: async () => false,
    consentReferenceId: ({ session, scopes }: any) => {
      if (!scopes.includes(SCOPE.select)) return undefined
      if (typeof session.yggSelectedPid !== 'number')
        throw new APIError('BAD_REQUEST', { error: 'invalid_request', error_description: 'no profile selected' })
      return toReference(session.yggSelectedPid)
    },
  }
}

/**
 * 会话服务器（/sessionserver/session/minecraft/join）对 Yggdrasil Connect 访问令牌的校验。
 * 直接按哈希查表，不走 introspection：introspection 要求调用方是签发令牌的客户端或其关联资源。
 * 返回 null 表示不允许进服。
 */
export async function verifyJoinToken(db: Kysely<any>, accessToken: string) {
  const row = await db
    .selectFrom('oauthAccessToken')
    .selectAll()
    .where('token', '=', sha256(accessToken))
    .executeTakeFirst()
  if (!row || row.revoked || new Date(row.expiresAt).getTime() <= Date.now()) return null
  const scopes = parseScopes(typeof row.scopes === 'string' && row.scopes.startsWith('[') ? JSON.parse(row.scopes) : row.scopes)
  const pid = fromReference(row.referenceId)
  const uid = Number(row.userId)
  // 进服必须同时满足：有 Join scope、绑定了角色、角色仍归属于令牌的用户、客户端未被禁用
  if (!scopes.includes(SCOPE.join) || pid === null) return null
  if (!(await findOwnedPlayer(db, pid, uid))) return null
  const client = await db.selectFrom('oauthClient').select('disabled').where('clientId', '=', row.clientId).executeTakeFirst()
  if (!client || client.disabled) return null
  return { uid, scopes, pid, clientId: String(row.clientId) }
}
