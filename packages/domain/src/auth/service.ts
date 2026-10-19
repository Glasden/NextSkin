import { readAuthBoolean, readAuthDate, type IsoTimestamp, type CoreDatabase, type UserRole } from '@nextskin/db'
import type { Kysely } from 'kysely'
import type { MailService } from '../mail/service.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { AUTH_BASE_PATH, CLIENT_IP_HEADER, createAuth, type Auth } from './auth.ts'
import { normalizeClientAuthentication } from './client-authentication.ts'
import type { PluginPasswordVerifier } from './password.ts'
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
  mail: MailService
  /** passwordHasher 插件（ADR-0033） */
  passwordPlugins?: PluginPasswordVerifier
  onPasswordChanged?: (uid: number) => Promise<void>
}

export interface SessionUser {
  uid: number
  nickname: string
  email: string
  role: UserRole
  locale: string | null
}

/** 验证邮件里的链接校验完令牌后回到网页的结果页；失败时 Better Auth 再加上 error 参数 */
const VERIFY_EMAIL_CALLBACK = '/verify-email?status=verified'
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
        passwordPlugins: options.passwordPlugins,
        mail: options.mail,
        onPasswordChanged: options.onPasswordChanged,
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
    /** @param requestRoot 客户端看到的站点地址；开发环境没有设置站点地址时，用它创建 Better Auth 实例 */
    async security(
      uid: number,
      requestRoot = '',
    ): Promise<{
      twoFactorEnabled: boolean
      backupCodesRemaining: number | null
      passkeys: {
        id: string
        name: string | null
        createdAt: IsoTimestamp | null
        backedUp: boolean
        deviceType: string
      }[]
    }> {
      const user = await db.selectFrom('users').select('two_factor_enabled').where('id', '=', uid).executeTakeFirst()
      const twoFactorEnabled = readAuthBoolean(user?.two_factor_enabled ?? false)
      const auth = twoFactorEnabled ? await instance(requestRoot) : null
      const codes = auth ? await auth.api.viewBackupCodes({ body: { userId: String(uid) } }) : null
      const rows = await db
        .selectFrom('passkeys')
        .selectAll()
        .where('user_id', '=', uid)
        .orderBy('created_at')
        .orderBy('id')
        .execute()
      return {
        twoFactorEnabled,
        backupCodesRemaining: codes?.backupCodes.length ?? null,
        passkeys: rows.map((row) => ({
          id: String(row.id),
          name: row.name,
          createdAt: row.created_at === null ? null : readAuthDate(row.created_at),
          backedUp: readAuthBoolean(row.backed_up),
          deviceType: row.device_type,
        })),
      }
    },
    /** 让 Better Auth 自己生成过期 Cookie，名称、Secure 前缀和属性与登录完全相同。 */
    async clearSessionCookies(headers: Headers, requestRoot: string): Promise<string[]> {
      const auth = await instance(requestRoot)
      if (!auth) throw new Error('site_url_required')
      const result = await auth.api.signOut({ headers, returnHeaders: true })
      return result.headers.getSetCookie()
    },
    /** 注册提交后调用；令牌由 Better Auth 自己签发，复用 /verify-email 的校验。 */
    async sendVerificationEmail(email: string): Promise<void> {
      const auth = await instance('')
      if (!auth) throw new Error('site_url_required')
      await auth.api.sendVerificationEmail({ body: { email, callbackURL: VERIFY_EMAIL_CALLBACK } })
    },
    /**
     * 处理 /api/auth/* 的请求。
     * @param requestRoot 客户端看到的站点地址（Next 里 request.url 的 host 是它自己的监听地址）
     */
    async handle(request: Request, requestRoot: string, clientIp: string | null): Promise<Response> {
      const headers = new Headers(request.headers)
      headers.delete(CLIENT_IP_HEADER)
      if (clientIp !== null) headers.set(CLIENT_IP_HEADER, clientIp)
      // Next 的 Request 是 Proxy，不能传给 Node Request 构造器做品牌检查。
      // 显式传 URL、方法和原始 body 流；Node 的流请求需要 duplex，再交给 OAuth 认证改写。
      const init = {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        duplex: 'half' as const,
      }
      request = new Request(request.url, init)
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

    async createSession(input: {
      email: string
      password: string
      clientIp: string
      userAgent: string | null
      requestRoot: string
    }): Promise<string[]> {
      const auth = await instance(input.requestRoot)
      if (!auth) throw new Error('site_url_required')
      const headers = new Headers({ [CLIENT_IP_HEADER]: input.clientIp })
      if (input.userAgent !== null) headers.set('user-agent', input.userAgent)
      const result = await auth.api.signInEmail({
        body: { email: input.email.trim().toLowerCase(), password: input.password, rememberMe: true },
        headers,
        returnHeaders: true,
      })
      return result.headers.getSetCookie()
    },

    /** 当前请求的登录用户；没有登录或会话失效时返回 null */
    async getSessionUser(headers: Headers, requestRoot: string): Promise<SessionUser | null> {
      headers = new Headers(headers)
      headers.delete(CLIENT_IP_HEADER)
      const auth = await instance(requestRoot)
      if (!auth) return null
      const session = await auth.api.getSession({ headers })
      if (!session) return null
      const uid = Number(session.user.id)
      const row = await db
        .selectFrom('users')
        .select(['id', 'nickname', 'email', 'role', 'locale'])
        .where('id', '=', uid)
        .executeTakeFirst()
      return row ? { uid: row.id, nickname: row.nickname, email: row.email, role: row.role, locale: row.locale } : null
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
