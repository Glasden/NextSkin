import { readAuthBoolean, readAuthDate, type IsoTimestamp, type CoreDatabase, type UserRole } from '@nextskin/db'
import { isAPIError } from 'better-auth/api'
import {
  DEVICE_CODE_GRANT_TYPE,
  isValidScopeSet,
  OAUTH_SCOPES,
  SHARED_OAUTH_CLIENT_ID,
  splitScopes,
} from '../oauth/scopes.ts'
import { readClient, type OAuthClientSummary } from '../oauth/devices.ts'
import { DomainError } from '../errors.ts'
import type { CaptchaService } from '../captcha/service.ts'
import type { Kysely } from 'kysely'
import type { MailService } from '../mail/service.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { AUTH_BASE_PATH, CLIENT_IP_HEADER, createAuth, type Auth } from './auth.ts'
import { normalizeClientAuthentication } from './client-authentication.ts'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-policy.ts'
import type { PluginPasswordVerifier } from './password.ts'
import { withoutSerialUnsafeMetadata } from './serial-safety.ts'
import { authorizationClient, authorizationTrustError, signedAuthorizationQuery, splitPrompt } from './authorization.ts'

export type ConsentRequestView =
  | { status: 'invalid' }
  | {
      status: 'ready'
      /** 提交给 /oauth2/consent 的 oauth_query：只含签过名的参数。 */
      oauthQuery: string
      client: OAuthClientSummary
      /** 回调地址的主机（含端口）；没有主机的自定义协议地址给协议名。 */
      redirectHost: string
      scopes: string[]
    }

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
  captcha?: Pick<CaptchaService, 'verify'>
  /** passwordHasher 插件（ADR-0033） */
  passwordPlugins?: PluginPasswordVerifier
  onPasswordChanged?: (uid: number) => Promise<void>
}

export interface SessionUser {
  uid: number
  /** Better Auth 会话的 id：发起第三方绑定时记下，写绑定之前确认这个会话还在（ADR-0036） */
  sessionId: number
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
  let cached: { key: string; auth: Auth; ready: Promise<unknown> } | undefined

  const resolveSiteUrl = (value: string, requestRoot: string) =>
    value.replace(/\/+$/, '') || (options.production ? '' : requestRoot.replace(/\/+$/, ''))

  /** 地址、名称和令牌有效期都在创建时固定，设置改变后换实例，已签发的令牌不受影响。 */
  async function instance(requestRoot: string): Promise<Auth | null> {
    const values = await settings.read([
      'site.url',
      'site.name',
      'yggdrasil.tokenValidSeconds',
      'yggdrasil.tokenRefreshableSeconds',
    ])
    const siteUrl = resolveSiteUrl(values['site.url'], requestRoot)
    if (!siteUrl) return null
    const key = JSON.stringify([
      siteUrl,
      values['site.name'],
      values['yggdrasil.tokenValidSeconds'],
      values['yggdrasil.tokenRefreshableSeconds'],
    ])
    if (cached?.key !== key) {
      const auth = createAuth({
        db,
        secretKey: options.secretKey,
        siteUrl,
        siteName: values['site.name'],
        tokenValidSeconds: values['yggdrasil.tokenValidSeconds'],
        tokenRefreshableSeconds: values['yggdrasil.tokenRefreshableSeconds'],
        requireEmailVerification: async () =>
          (await settings.read(['auth.requireEmailVerification']))['auth.requireEmailVerification'],
        tokensPerUser: async () => (await settings.read(['yggdrasil.tokensPerUser']))['yggdrasil.tokensPerUser'],
        legacyPasswordSalt: async () => (await settings.read(['auth.legacyPasswordSalt']))['auth.legacyPasswordSalt'],
        passwordPlugins: options.passwordPlugins,
        mail: options.mail,
        captcha: options.captcha,
        onPasswordChanged: options.onPasswordChanged,
      })
      // 首次并发签名会各建一把密钥；让同一实例的请求等同一个预热 Promise（SJMCL 只读 keys[0]）。
      // 预热失败（数据库暂时不可用）时丢掉这个实例，下一个请求重新预热，不让失败一直缓存着
      const ready = auth.api.getJwks().catch((error: unknown) => {
        if (cached?.auth === auth) cached = undefined
        throw error
      })
      cached = { key, auth, ready }
    }
    const current = cached
    await current.ready
    return current.auth
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
    /** 登录页：还原 Better Auth 签过名的授权参数，登录后重新打开授权流程（ADR-0037）。 */
    async authorizationContinuation(
      search: string,
      headers: Headers,
      requestRoot: string,
    ): Promise<{ next: string; resume: boolean } | null> {
      const auth = await instance(requestRoot)
      if (!auth) return null
      const query = await signedAuthorizationQuery(search, (await auth.$context).secret)
      if (!query) return null
      headers = new Headers(headers)
      headers.delete(CLIENT_IP_HEADER)
      const session = await auth.api.getSession({ headers })
      const loginPrompts = ['login', 'create', 'select_account']
      const prompt = splitPrompt(query.get('prompt'))
      const maxAge = query.get('max_age')
      const maxAgeSeconds = maxAge?.trim() ? Number(maxAge) : NaN
      // 与 Better Auth 的 isWithinMaxAge 相同：0 永远要求重新登录，时间从会话创建时算。
      const fresh =
        maxAge === null ||
        (Number.isInteger(maxAgeSeconds) &&
          maxAgeSeconds > 0 &&
          session !== null &&
          Date.now() - new Date(session.session.createdAt).getTime() <= maxAgeSeconds * 1000)
      const resume = !!session && !prompt.some((value) => loginPrompts.includes(value)) && fresh
      for (const key of ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param', 'max_age']) query.delete(key)
      const remaining = prompt.filter((value) => !loginPrompts.includes(value))
      if (remaining.length) query.set('prompt', remaining.join(' '))
      else query.delete('prompt')
      return { next: `${AUTH_BASE_PATH}/oauth2/authorize?${query.toString()}`, resume }
    },

    /** 同意页：先验签再显示应用和回调地址，不能让伪造链接借本站为任意应用背书。 */
    async consentRequest(search: string, requestRoot: string): Promise<ConsentRequestView> {
      const auth = await instance(requestRoot)
      if (!auth) return { status: 'invalid' }
      const query = await signedAuthorizationQuery(search, (await auth.$context).secret)
      if (!query) return { status: 'invalid' }
      const clientId = query.get('client_id')
      const redirectUri = query.get('redirect_uri')
      const client = await authorizationClient(db, clientId)
      const scopes = splitScopes(query.get('scope'))
      if (authorizationTrustError(client, clientId, redirectUri) || !isValidScopeSet(scopes))
        return { status: 'invalid' }
      const summary = await readClient(db, clientId)
      if (!summary || summary.disabled) return { status: 'invalid' }
      const redirect = new URL(redirectUri!)
      return {
        status: 'ready',
        oauthQuery: query.toString(),
        client: summary.client,
        redirectHost: redirect.host || redirect.protocol,
        scopes,
      }
    },

    async openIdConfigurationUrl(requestRoot: string): Promise<string | null> {
      const values = await settings.read(['site.url'])
      const siteUrl = resolveSiteUrl(values['site.url'], requestRoot)
      return siteUrl.startsWith('https://') ? `${siteUrl}${DISCOVERY_PATH}` : null
    },
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
        const filtered = withoutSerialUnsafeMetadata(metadata)
        filtered.token_endpoint_auth_methods_supported = [
          ...new Set([...((filtered.token_endpoint_auth_methods_supported as string[]) ?? []), 'none']),
        ]
        filtered.grant_types_supported = ['authorization_code', 'refresh_token', DEVICE_CODE_GRANT_TYPE]
        for (const key of [
          'registration_endpoint',
          'end_session_endpoint',
          'backchannel_logout_supported',
          'backchannel_logout_session_supported',
        ])
          delete filtered[key]
        if (Array.isArray(filtered.prompt_values_supported))
          filtered.prompt_values_supported = filtered.prompt_values_supported.filter(
            (value) => value !== 'select_account' && value !== 'create',
          )
        filtered.scopes_supported = OAUTH_SCOPES
        filtered.claims_parameter_supported = false
        filtered.claims_supported = [
          ...new Set([...((filtered.claims_supported as string[]) ?? []), 'selectedProfile', 'availableProfiles']),
        ]
        const shared = await db
          .selectFrom('oauth_clients')
          .select(['client_id', 'disabled'])
          .where('client_id', '=', SHARED_OAUTH_CLIENT_ID)
          .executeTakeFirst()
        if (shared?.client_id === SHARED_OAUTH_CLIENT_ID && !readAuthBoolean(shared.disabled ?? false))
          filtered.shared_client_id = SHARED_OAUTH_CLIENT_ID
        const body = request.method === 'HEAD' ? null : JSON.stringify(filtered)
        return new Response(body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': METADATA_CACHE_CONTROL },
        })
      }
      return auth.handler(await normalizeClientAuthentication(request, AUTH_BASE_PATH, registeredAuthMethod))
    },

    /**
     * 第三方登录之后签发会话（ADR-0034）。开了两步验证时没有会话，只有第二步的挑战 Cookie，页面接着去 /sign-in/two-factor。
     * headers 要带上请求里的 Cookie："信任这台设备"的 Cookie 在里面
     */
    async createExternalSession(input: {
      uid: number
      headers: Headers
      clientIp: string
      requestRoot: string
    }): Promise<{ cookies: string[]; twoFactor: boolean }> {
      const auth = await instance(input.requestRoot)
      if (!auth) throw new Error('site_url_required')
      const headers = new Headers(input.headers)
      headers.set(CLIENT_IP_HEADER, input.clientIp)
      const result = await auth.api.externalSignIn({ body: { uid: input.uid }, headers, returnHeaders: true })
      return { cookies: result.headers.getSetCookie(), twoFactor: result.response.twoFactorRedirect }
    },

    /** 当前会话是不是刚登录的（`session.freshAge`）：绑定第三方账号、设置密码之前检查 */
    async isFreshSession(headers: Headers, requestRoot: string): Promise<boolean> {
      headers = new Headers(headers)
      headers.delete(CLIENT_IP_HEADER)
      const auth = await instance(requestRoot)
      if (!auth) return false
      try {
        await auth.api.freshSession({ headers })
        return true
      } catch (error) {
        if (isAPIError(error)) return false
        throw error
      }
    },

    /**
     * 给没有密码的账号设置密码（经第三方登录建的账号，ADR-0034），用 Better Auth 只能在服务端调用的 setPassword。
     * 调用方已经确认会话是刚登录的。设好之后和改密码一样发事件
     */
    async setPassword(input: { uid: number; headers: Headers; password: string; requestRoot: string }): Promise<void> {
      const headers = new Headers(input.headers)
      headers.delete(CLIENT_IP_HEADER)
      const auth = await instance(input.requestRoot)
      if (!auth) throw new Error('site_url_required')
      try {
        await auth.api.setPassword({ body: { newPassword: input.password }, headers })
      } catch (error) {
        if (!isAPIError(error)) throw error
        const code = (error.body as { code?: unknown } | undefined)?.code
        if (code === 'PASSWORD_TOO_SHORT') throw new DomainError('password_too_short', { min: MIN_PASSWORD_LENGTH })
        if (code === 'PASSWORD_TOO_LONG') throw new DomainError('password_too_long', { max: MAX_PASSWORD_LENGTH })
        if (code === 'PASSWORD_ALREADY_SET') throw new DomainError('password_already_set')
        throw new DomainError('unauthenticated')
      }
      try {
        await options.onPasswordChanged?.(input.uid)
      } catch {
        // 密码已经设好；通知失败不能改变结果，也不能记录用户数据
        console.warn('[auth] password_event_failed')
      }
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
      return row
        ? {
            uid: row.id,
            sessionId: Number(session.session.id),
            nickname: row.nickname,
            email: row.email,
            role: row.role,
            locale: row.locale,
          }
        : null
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
