/**
 * Google 登录（BS 的 oauth-google，ADR-0034）。
 *
 * 身份取自令牌响应里的 ID 令牌，经 TLS 直接从令牌端点拿到，按 OIDC Core 3.1.3.7 不验签，只核对 iss、aud、exp。
 * subject 用 `sub`，`emailVerified` 用 `email_verified`。
 */
import { authorizationUrl, exchangeCode, readIdToken } from '@nextskin/oauth-client'
import { definePlugin, secret, z } from '@nextskin/plugin-sdk'

const settings = z.object({ clientId: z.string().trim().min(1).max(200), clientSecret: secret() })
const identitySchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1).nullish(),
  email_verified: z.boolean().optional(),
  name: z.string().nullish(),
})

export default definePlugin({
  capabilities: [],
  network: ['https://oauth2.googleapis.com'],
  settings,
  providers: {
    login: [
      {
        id: 'google',
        label: 'login.google',
        icon: 'google',
        async authorizeUrl({ state, codeChallenge, redirectUri, ctx }) {
          return authorizationUrl(
            'https://accounts.google.com/o/oauth2/v2/auth',
            { clientId: ctx.settings.clientId, state, codeChallenge, redirectUri },
            { scope: 'openid email profile' },
          )
        },
        async exchange({ query, codeVerifier, redirectUri, ctx }) {
          const token = await exchangeCode((url, init) => ctx.fetch(url, init), 'https://oauth2.googleapis.com/token', {
            query,
            codeVerifier,
            redirectUri,
            ...ctx.settings,
          })
          const identity = identitySchema.safeParse(
            readIdToken(token.id_token, {
              clientId: ctx.settings.clientId,
              issuers: ['https://accounts.google.com', 'accounts.google.com'],
            }),
          )
          if (!identity.success) throw new Error('invalid user response')
          return {
            subject: identity.data.sub,
            email: identity.data.email ?? null,
            emailVerified: identity.data.email_verified === true,
            displayName: identity.data.name ?? null,
          }
        },
      },
    ],
  },
})
