/**
 * Microsoft 登录（BS 的 oauth-microsoft-live，ADR-0034）。
 *
 * 只接个人账号（`consumers` 租户）：Minecraft 玩家用的就是个人账号；工作和学校账号的邮箱由租户管理员填写、未经验证。
 * 身份取自令牌响应里的 ID 令牌，经 TLS 直接从令牌端点拿到，按 OIDC Core 3.1.3.7 不验签，只核对 iss、aud、exp。
 * subject 用 `oid`。个人账号的邮箱是否都验证过拿不准，`emailVerified` 一律为 false。
 */
import { authorizationUrl, exchangeCode, readIdToken } from '@nextskin/oauth-client'
import { definePlugin, secret, z } from '@nextskin/plugin-sdk'

const settings = z.object({ clientId: z.string().trim().min(1).max(200), clientSecret: secret() })
const identitySchema = z.object({
  oid: z.string().min(1),
  email: z.string().min(1).nullish(),
  name: z.string().nullish(),
})

export default definePlugin({
  capabilities: [],
  network: ['https://login.microsoftonline.com'],
  settings,
  providers: {
    login: [
      {
        id: 'microsoft',
        label: 'login.microsoft',
        icon: 'app-windows',
        async authorizeUrl({ state, codeChallenge, redirectUri, ctx }) {
          return authorizationUrl(
            'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
            { clientId: ctx.settings.clientId, state, codeChallenge, redirectUri },
            { scope: 'openid email profile', response_mode: 'query' },
          )
        },
        async exchange({ query, codeVerifier, redirectUri, ctx }) {
          const token = await exchangeCode(
            (url, init) => ctx.fetch(url, init),
            'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
            {
              query,
              codeVerifier,
              redirectUri,
              ...ctx.settings,
            },
          )
          const identity = identitySchema.safeParse(
            readIdToken(token.id_token, {
              clientId: ctx.settings.clientId,
              issuers: ['https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0'],
            }),
          )
          if (!identity.success) throw new Error('invalid user response')
          return {
            // sub 随应用注册变化；oid 才能在管理员重建应用后继续认出这个人。
            subject: identity.data.oid,
            email: identity.data.email ?? null,
            // 个人账号的 email 是否都经过验证拿不准，不能用它认领站内已有账号。
            emailVerified: false,
            displayName: identity.data.name ?? null,
          }
        },
      },
    ],
  },
})
