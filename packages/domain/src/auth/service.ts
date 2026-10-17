import type { CoreDatabase, UserRole } from '@nextskin/db'
import type { Kysely } from 'kysely'
import type { createSettingQueries } from '../settings/queries.ts'
import { AUTH_BASE_PATH, createAuth, type Auth } from './auth.ts'
import { normalizeClientAuthentication } from './client-authentication.ts'
import { withoutSerialUnsafeMetadata } from './serial-safety.ts'

export interface AuthServiceOptions {
  db: Kysely<CoreDatabase>
  secretKey: string
  settings: ReturnType<typeof createSettingQueries>
  /**
   * 生产环境必须在设置里填写站点地址：找回密码邮件、OAuth 的 issuer 都由它生成，
   * 不能取自请求的 Host 头。开发环境没填时退回到请求的地址
   */
  production: boolean
}

export interface SessionUser {
  uid: number
  nickname: string
  email: string
  role: UserRole
}

const DISCOVERY_PATH = `${AUTH_BASE_PATH}/.well-known/openid-configuration`
const METADATA_CACHE_CONTROL = 'public, max-age=15, stale-while-revalidate=15, stale-if-error=86400'

export function createAuthService(options: AuthServiceOptions) {
  const { db, settings } = options
  let cached: { key: string; auth: Auth } | undefined

  /** 站点地址或站点名改了就换一个实例：baseURL、passkey 的 rpID、两步验证的 issuer 都在创建时确定 */
  async function instance(requestRoot: string): Promise<Auth | null> {
    const values = await settings.read(['site.url', 'site.name'])
    const siteUrl = values['site.url'].replace(/\/+$/, '') || (options.production ? '' : requestRoot)
    if (!siteUrl) return null
    const key = JSON.stringify([siteUrl, values['site.name']])
    if (cached?.key !== key) {
      const auth = createAuth({
        db,
        secretKey: options.secretKey,
        siteUrl,
        siteName: values['site.name'],
        legacyPasswordSalt: async () => (await settings.read(['auth.legacyPasswordSalt']))['auth.legacyPasswordSalt'],
      })
      cached = { key, auth }
    }
    return cached.auth
  }

  async function registeredAuthMethod(clientId: string) {
    const row = await db
      .selectFrom('oauth_clients')
      .select(['client_id', 'token_endpoint_auth_method'])
      .where('client_id', '=', clientId)
      .executeTakeFirst()
    // MySQL 的 utf8mb4_bin 比较忽略末尾空格，查到之后再逐字比较一次（packages/db/AGENTS.md）
    return row?.client_id === clientId ? row.token_endpoint_auth_method : undefined
  }

  return {
    /**
     * 处理 /api/auth/* 的请求。
     * @param requestRoot 客户端看到的站点地址（Next 里 request.url 的 host 是它自己的监听地址）
     */
    async handle(request: Request, requestRoot: string): Promise<Response> {
      const auth = await instance(requestRoot)
      if (!auth)
        return Response.json(
          { error: 'site_url_required', error_description: 'the site URL has not been configured' },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        )
      // Better Auth 把发现文档做成了只能在服务端调用的端点，由我们按 OIDC 的位置（issuer + /.well-known/…）提供
      if (new URL(request.url).pathname === DISCOVERY_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
        const metadata = (await auth.api.getOpenIdConfig({ headers: request.headers })) as Record<string, unknown>
        const body = request.method === 'HEAD' ? null : JSON.stringify(withoutSerialUnsafeMetadata(metadata))
        return new Response(body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': METADATA_CACHE_CONTROL },
        })
      }
      return auth.handler(await normalizeClientAuthentication(request, AUTH_BASE_PATH, registeredAuthMethod))
    },

    /** 当前请求的登录用户；没有登录或会话失效时返回 null */
    async getSessionUser(headers: Headers, requestRoot: string): Promise<SessionUser | null> {
      const auth = await instance(requestRoot)
      if (!auth) return null
      const session = await auth.api.getSession({ headers })
      if (!session) return null
      const uid = Number(session.user.id)
      const row = await db
        .selectFrom('users')
        .select(['id', 'nickname', 'email', 'role'])
        .where('id', '=', uid)
        .executeTakeFirst()
      return row ? { uid: row.id, nickname: row.nickname, email: row.email, role: row.role } : null
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
