import { createHash, hkdfSync } from 'node:crypto'
import { oauthDeviceAuthorization, oauthProvider } from '@better-auth/oauth-provider'
import { defineRequestState, hasRequestState } from '@better-auth/core/context'
import { passkey } from '@better-auth/passkey'
import { dialectOf, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import { betterAuth, getCurrentAdapter, type BetterAuthOptions } from 'better-auth'
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api'
import { hashPassword } from 'better-auth/crypto'
import { jwt, twoFactor } from 'better-auth/plugins'
import type { Kysely } from 'kysely'
import { isValidScopeSet, OAUTH_SCOPES, splitScopes } from '../oauth/scopes.ts'
import { bindDeviceSelection, consentReferenceId, oauthQueryGuard, yggdrasilConnect } from './connect.ts'
import { connectClaims } from './connect-claims.ts'
import type { MailService } from '../mail/service.ts'
import {
  EMAIL_VERIFICATION_TTL_SECONDS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  RESET_PASSWORD_TTL_SECONDS,
} from './password-policy.ts'
import { externalSession } from './external-session.ts'
import { coreModelNaming, withNamingConvention } from './naming.ts'
import {
  isCurrentPasswordHash,
  matchStoredPassword,
  verifyStoredPassword,
  type PluginPasswordVerifier,
  type StoredPasswordCheck,
} from './password.ts'
import { serialSafety } from './serial-safety.ts'

/** Better Auth 挂在这个路径下（Hono 的 /api/auth/*） */
export const AUTH_BASE_PATH = '/api/auth'
export const CLIENT_IP_HEADER = 'x-nextskin-client-ip'

export interface AuthConfig {
  tokenValidSeconds?: number
  tokenRefreshableSeconds?: number
  tokensPerUser?: () => Promise<number>
  requireEmailVerification?: () => Promise<boolean>
  db: Kysely<CoreDatabase>
  /** .env 里的 NEXTSKIN_SECRET；Better Auth 的密钥由它派生 */
  secretKey: string
  /** 站点根地址，例如 https://skin.example.com，不带末尾斜杠 */
  siteUrl: string
  siteName: string
  /** BS 的全站盐（旧站 .env 的 SALT），只有校验旧摘要格式的密码时才读 */
  legacyPasswordSalt: () => Promise<string>
  /** passwordHasher 插件（ADR-0033）；没有时插件格式的哈希一律不通过 */
  passwordPlugins?: PluginPasswordVerifier
  mail?: MailService
  onPasswordChanged?: (uid: number) => Promise<void>
}

/** sha256 + base64url。令牌只存这个值，会话服务器按同样的方式查表（ADR-0007） */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

/** 与设置加密用不同的派生参数，两者互不影响（settings/codec.ts） */
export function deriveSecret(secretKey: string): string {
  return Buffer.from(hkdfSync('sha256', secretKey, 'NextSkin Better Auth v1', 'better-auth secret', 32)).toString('hex')
}

/**
 * 日志里去掉 URL 的查询串和片段。Better Auth 会把请求里的地址原样写进日志，例如被拒绝的 callbackURL、
 * Origin，查询串里可能带着令牌（不变量 11）
 */
export function redactLogMessage(message: string): string {
  return message.replace(/([?#])[^\s"'<>]+/g, '$1[redacted]')
}

/** 这次请求里核对通过的密码哈希。改密码时在 Better Auth 写入的事务里拿它和现在的哈希比较，见 databaseHooks */
const verifiedPasswordHash = defineRequestState<string | null>(() => null)

/** Better Auth 的日志只输出消息本身：附带的参数可能是请求体或带查询参数的错误（不变量 11） */
const logger: BetterAuthOptions['logger'] = {
  level: 'warn',
  log: (level, message) => {
    const line = `[auth] ${redactLogMessage(message)}`
    if (level === 'error') console.error(line)
    else console.warn(line)
  },
}

/** Better Auth 的完整配置。schema 比对测试直接用它，不创建实例（创建实例会在后台连库做 schema 检查） */
export function authOptions(config: AuthConfig) {
  const { db } = config
  const tokenValidSeconds = config.tokenValidSeconds ?? 259200
  const { providerOptions } = connectClaims(db, config.siteUrl)
  const site = new URL(config.siteUrl)
  const passwords: StoredPasswordCheck = { legacySalt: config.legacyPasswordSalt, plugins: config.passwordPlugins }
  async function passwordChanged(uid: string) {
    try {
      await config.onPasswordChanged?.(Number(uid))
    } catch {
      // 密码已经提交；通知失败不能改变结果，也不能记录用户数据。
      console.warn('[auth] password_event_failed')
    }
  }
  return {
    appName: config.siteName,
    baseURL: config.siteUrl,
    basePath: AUTH_BASE_PATH,
    secret: deriveSecret(config.secretKey),
    // transaction 默认是 false：不打开的话，Better Auth 的多步写入不在同一个事务里（ADR-0007）
    database: { db, type: dialectOf(db), transaction: true },
    ...coreModelNaming(),
    session: { ...coreModelNaming().session, freshAge: 600 },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_TTL_SECONDS,
      sendResetPassword: async ({ user, url, token }) => {
        const mail = config.mail
        if (!mail || !(await mail.configured()))
          throw new APIError('SERVICE_UNAVAILABLE', { code: 'mail_not_configured' })
        // Better Auth 先按邮箱查出用户、再写入记录、最后调这里，都不加锁；改邮箱的事务可能在这中间删掉找回链接，
        // 新写入的记录删不到，信又发到旧地址。所以锁住用户行（同 lockUser）再重读邮箱：要么排在改邮箱的事务前面
        // （信发到旧地址，但记录随后被它删掉），要么等它提交之后读到新邮箱，删掉这条记录、不发信。
        // 只重读不加锁不够：MySQL 和 PostgreSQL 都是 READ COMMITTED，改邮箱的事务提交之前读到的还是旧邮箱（ADR-0036）
        const uid = Number(user.id)
        await transactionWithRetry(db, async (tx) => {
          await tx
            .updateTable('users')
            .set((eb) => ({ role: eb.ref('role') }))
            .where('id', '=', uid)
            .execute()
          const current = await tx.selectFrom('users').select('email').where('id', '=', uid).executeTakeFirst()
          if (current?.email !== user.email) {
            await tx.deleteFrom('verifications').where('identifier', '=', `reset-password:${token}`).execute()
            return
          }
          await mail.send('resetPassword', user, url, tx)
        })
      },
      // resetPassword 用 updateMany，account.update.after 只收到数量；此回调在它的事务提交后执行。
      onPasswordReset: ({ user }) => passwordChanged(user.id),
      password: {
        hash: hashPassword,
        // 从 BS 导入的旧哈希和插件格式的哈希在这里校验，登录成功后由下面的 after 钩子换成当前算法
        verify: async (input) => {
          const valid = await verifyStoredPassword(input, passwords)
          if (valid && (await hasRequestState())) await verifiedPasswordHash.set(input.hash)
          return valid
        },
      },
    },
    emailVerification: {
      expiresIn: EMAIL_VERIFICATION_TTL_SECONDS,
      sendVerificationEmail: async ({ user, url }) => {
        if (!config.mail || !(await config.mail.configured()))
          throw new APIError('SERVICE_UNAVAILABLE', { code: 'mail_not_configured' })
        await config.mail.send('verifyEmail', user, url)
      },
    },
    databaseHooks: {
      account: {
        update: {
          // Better Auth 改密码时在事务外核对当前密码（要算两次 scrypt），之后按行 id 直接写入新哈希，中间不锁任何行。
          // 后台改密码、收回账号恰好在这中间提交的话，管理员设的密码会被覆盖，连同 revokeOtherSessions 新建的会话，
          // 盗号的人就回来了，页面上也看不出来。所以在 Better Auth 写入的同一个事务里，密码还是核对时那个哈希才继续：
          // 这条条件更新锁住密码行，后台的事务还没提交就等它提交，再按提交之后的值判断（ADR-0036"并发"）
          before: async (data, ctx) => {
            if (ctx?.path !== '/change-password' || !('password' in data)) return
            const userId = ctx.context.session?.user.id
            const verified = await verifiedPasswordHash.get()
            const unchanged =
              userId && verified
                ? await (
                    await getCurrentAdapter(ctx.context.adapter)
                  ).update({
                    model: 'account',
                    where: [
                      { field: 'userId', value: userId },
                      { field: 'providerId', value: 'credential' },
                      { field: 'password', value: verified },
                    ],
                    update: { password: verified },
                  })
                : null
            if (!unchanged) throw new APIError('BAD_REQUEST', { code: 'INVALID_PASSWORD', message: 'Invalid password' })
          },
          // with-hooks 的 queueAfterTransactionHook 保证在 Better Auth 提交之后执行。
          after: async (account, ctx) => {
            if (ctx?.path !== '/change-password' || account.providerId !== 'credential' || !account.password) return
            await passwordChanged(account.userId)
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // 上游找回密码对不存在的邮箱提前返回；在查用户之前统一拒绝，避免泄露账号是否存在。
        if (
          (ctx.path === '/request-password-reset' || ctx.path === '/send-verification-email') &&
          (!config.mail || !(await config.mail.configured()))
        )
          throw new APIError('SERVICE_UNAVAILABLE', { code: 'mail_not_configured' })
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email' || !ctx.context.newSession) return
        // newSession 只在密码校验通过之后才有。Better Auth 1.7.10 把 ctx.body.password 原样传给 verify，不会先 trim；
        // 旧哈希可能是按 trim 之后的值通过的，所以重新求出通过的那个值，按它换算法。插件格式的哈希要再调用一次插件
        const password: unknown = (ctx.body as Record<string, unknown> | undefined)?.password
        const userId = ctx.context.newSession.user.id
        const accounts = await ctx.context.internalAdapter.findAccounts(userId)
        const credential = accounts.find((account) => account.providerId === 'credential')
        if (typeof password === 'string' && credential?.password && !isCurrentPasswordHash(credential.password)) {
          const matched = await matchStoredPassword({ hash: credential.password, password }, passwords)
          // 只替换核对过的那个旧哈希：核对要等插件、算 bcrypt，这期间密码被重设或修改了，就不能拿旧密码覆盖它
          if (matched !== null)
            await db
              .updateTable('accounts')
              .set({ password: await hashPassword(matched) })
              .where('user_id', '=', Number(userId))
              .where('provider_id', '=', 'credential')
              .where('password', '=', credential.password)
              .execute()
        }
      }),
    },
    // /token：jwt 插件给会话签发 JWT，用不到；/update-user：昵称等字段改动要经过领域用例（不变量 4）
    // /change-email、/delete-user：由领域用例代替，确认链接和删除事件必须在业务事务里（ADR-0023）
    // 账号端点：第三方账号的绑定、解绑由领域用例处理（ADR-0034）。不关的话 /unlink-account 能删掉自己的密码，
    // 绕过"解绑之后要还有能用的登录方式"；核心不存第三方的令牌，取令牌的几个端点也用不到
    // /oauth2/continue：登录后重新打开授权地址，避免绕过同意请求的角色选择（ADR-0037）。
    disabledPaths: [
      '/token',
      '/update-user',
      '/change-email',
      '/delete-user',
      '/link-social',
      '/unlink-account',
      '/list-accounts',
      '/account-info',
      '/get-access-token',
      '/refresh-token',
      '/oauth2/continue',
      '/oauth2/register',
      '/oauth2/create-client',
      '/admin/oauth2/create-client',
      '/oauth2/update-client',
      '/admin/oauth2/update-client',
      '/oauth2/delete-client',
      '/oauth2/get-client',
      '/oauth2/get-clients',
      '/oauth2/client/rotate-secret',
      '/oauth2/client/rotate-keys',
      '/oauth2/public-client',
      '/oauth2/public-client-prelogin',
      '/oauth2/get-consent',
      '/oauth2/get-consents',
      '/oauth2/update-consent',
      '/oauth2/delete-consent',
      '/oauth2/end-session',
      '/oauth2/end-session/confirm',
      '/device/token',
      '/device',
      '/device/approve',
      '/device/deny',
      '/.well-known/oauth-authorization-server',
    ],
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      database: { generateId: 'serial' },
      cookiePrefix: 'nextskin',
    },
    rateLimit: { customRules: { '/oauth2/token': { window: 60, max: 300 }, '/device/code': { window: 60, max: 30 } } },
    telemetry: { enabled: false },
    logger,
    // 默认的错误处理用 Better Auth 模块级的 logger 打印错误消息，绕过上面的 logger。客户端错误已经在响应里，
    // 不再记录；服务端错误只记录类型，消息可能带着请求里的值或 SQL 参数（不变量 11）
    onAPIError: {
      // 不设时生产环境的默认错误页会落到首页 /?error=，丢失授权流程的错误说明。
      errorURL: '/oauth/error',
      onError: (error) => {
        if (isAPIError(error) && error.status !== 'INTERNAL_SERVER_ERROR') return
        console.error(`[auth] unhandled ${error instanceof Error ? error.name : typeof error}`)
      },
    },
    plugins: [
      oauthQueryGuard(),
      // ID 令牌用 RS256（ADR-0007）；Yggdrasil Connect 规范要求至少有一把 RSA 密钥
      withNamingConvention(
        jwt({ jwks: { keyPairConfig: { alg: 'RS256', modulusLength: 2048 } }, disableSettingJwtHeader: true }),
      ),
      withNamingConvention(
        oauthProvider({
          loginPage: '/sign-in',
          consentPage: '/oauth/consent',
          // 只为了 consentReferenceId 配置 postLogin，角色在同意请求里选择，没有额外的登录后步骤。
          postLogin: { page: '/oauth/consent', shouldRedirect: () => false, consentReferenceId },
          scopes: OAUTH_SCOPES,
          grantTypes: ['authorization_code', 'refresh_token'],
          accessTokenExpiresIn: tokenValidSeconds,
          idTokenExpiresIn: tokenValidSeconds,
          refreshTokenExpiresIn: Math.max(tokenValidSeconds, config.tokenRefreshableSeconds ?? 604800),
          ...providerOptions,
          storeTokens: { hash: (token) => Promise.resolve(sha256(token)) },
          storeClientSecret: { hash: (secret) => Promise.resolve(sha256(secret)) },
          // 不接受 DPoP（ADR-0015：serial 下它的防重放不起作用）
          dpop: { signingAlgorithms: [] },
          // 客户端管理经过领域用例；资源管理不开放（ADR-0037）。
          clientPrivileges: () => false,
          resourcePrivileges: () => false,
        }),
      ),
      withNamingConvention(
        bindDeviceSelection(
          oauthDeviceAuthorization({
            verificationUri: '/device',
            expiresIn: '10m',
            interval: '5s',
            onDeviceAuthRequest: (_clientId, scope) => {
              const scopes = splitScopes(scope)
              if (!scopes.length || !isValidScopeSet(scopes))
                throw new APIError('BAD_REQUEST', {
                  error: 'invalid_scope',
                  error_description: 'Invalid scope combination',
                })
              return Promise.resolve()
            },
          }),
          db,
        ),
      ),
      yggdrasilConnect(
        db,
        config.tokensPerUser ?? (() => Promise.resolve(10)),
        config.siteUrl,
        config.requireEmailVerification ?? (() => Promise.resolve(false)),
      ),
      withNamingConvention(twoFactor({ issuer: config.siteName })),
      withNamingConvention(passkey({ rpID: site.hostname, rpName: config.siteName, origin: site.origin })),
      serialSafety(),
      externalSession(),
    ],
  } satisfies BetterAuthOptions
}

export function createAuth(config: AuthConfig) {
  return betterAuth(authOptions(config))
}

export type Auth = ReturnType<typeof createAuth>
