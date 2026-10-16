import { oauthProvider } from '@better-auth/oauth-provider'
import bcrypt from 'bcryptjs'
import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { jwt } from 'better-auth/plugins'
import type { Kysely } from 'kysely'
import type { DialectName } from './db'
import {
  OAUTH_SCOPES,
  storeTokens,
  yggdrasilClaimsExtension,
  yggdrasilConnect,
  yggdrasilConsentReference,
  yggdrasilDeviceAuthorization,
} from './yggdrasil-connect'

export const BASE_URL = 'http://localhost:3000'
const SECRET = 'spike-only-secret-spike-only-secret-0123456789'

/** 运行时才知道的客户端信息（spike 里由场景脚本创建客户端后填入）。 */
export interface ClientRegistry {
  sharedClientId: string
  publicClientIds: Set<string>
}

/** BS 默认的 PWD_METHOD=BCRYPT（PHP password_hash，前缀 $2y$）。 */
const isLegacyBcrypt = (hash: string) => /^\$2[aby]\$/.test(hash)

export function createAuth(db: Kysely<any>, dialect: DialectName, clients: ClientRegistry) {
  return betterAuth({
    baseURL: BASE_URL,
    basePath: '/api/auth',
    secret: SECRET,
    // transaction 默认是 false：不打开的话，Better Auth 的多步写入不在同一个事务里
    database: { db, type: dialect, transaction: true },
    advanced: { database: { generateId: 'serial' } },
    // 映射到我们自己的用户表；注意主键列名不能改，只能叫 id
    user: { modelName: 'users', fields: { name: 'nickname' } },
    emailAndPassword: {
      enabled: true,
      password: {
        hash: hashPassword,
        verify: async ({ hash, password }) =>
          isLegacyBcrypt(hash) ? bcrypt.compare(password, hash) : verifyPassword({ hash, password }),
      },
    },
    hooks: {
      // 旧算法校验成功后立即换成当前算法
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email' || !ctx.context.newSession) return
        const userId = ctx.context.newSession.user.id
        const accounts = await ctx.context.internalAdapter.findAccounts(userId)
        const credential = accounts.find((account) => account.providerId === 'credential')
        if (credential?.password && isLegacyBcrypt(credential.password)) {
          await ctx.context.internalAdapter.updatePassword(userId, await hashPassword(String(ctx.body.password)))
        }
      }),
    },
    disabledPaths: ['/token'],
    plugins: [
      // 规范要求至少有一把 RSA 密钥，默认用 RS256 签 ID 令牌
      jwt({ jwks: { keyPairConfig: { alg: 'RS256', modulusLength: 2048 } } }),
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/oauth/consent',
        scopes: OAUTH_SCOPES,
        storeTokens,
        postLogin: yggdrasilConsentReference(),
        extensions: [yggdrasilClaimsExtension(db, () => clients.sharedClientId)],
      }),
      yggdrasilDeviceAuthorization(db),
      yggdrasilConnect(db, async () => clients.publicClientIds, SECRET),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
