/**
 * LittleSkin 登录（BS 的 oauth-littleskin，ADR-0034）。
 *
 * LittleSkin 是 BS 搭的站，OAuth 服务端是 Laravel Passport。身份取自 `/api/user`：subject 用 uid，
 * `emailVerified` 用 BS 用户的 `verified`。不传 scope，和 BS 原来的插件一样。
 */
import { authorizationUrl, exchangeCode, fetchJson } from '@nextskin/oauth-client'
import { definePlugin, secret, z } from '@nextskin/plugin-sdk'

const settings = z.object({ clientId: z.string().trim().min(1).max(200), clientSecret: secret() })
const tokenSchema = z.object({
  access_token: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._~+/-]+=*$/),
})
const userSchema = z.object({
  uid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  email: z.string().min(1).nullish(),
  verified: z.union([z.boolean(), z.literal(0), z.literal(1)]),
  nickname: z.string().nullish(),
})

export default definePlugin({
  capabilities: [],
  network: ['https://littleskin.cn'],
  settings,
  providers: {
    login: [
      {
        id: 'littleskin',
        label: 'login.littleskin',
        icon: 'login',
        async authorizeUrl({ state, codeChallenge, redirectUri, ctx }) {
          return authorizationUrl('https://littleskin.cn/oauth/authorize', {
            clientId: ctx.settings.clientId,
            state,
            codeChallenge,
            redirectUri,
          })
        },
        async exchange({ query, codeVerifier, redirectUri, ctx }) {
          const fetch = (...args: Parameters<typeof ctx.fetch>) => ctx.fetch(...args)
          const token = tokenSchema.safeParse(
            await exchangeCode(fetch, 'https://littleskin.cn/oauth/token', {
              query,
              codeVerifier,
              redirectUri,
              ...ctx.settings,
            }),
          )
          if (!token.success) throw new Error('invalid token response')
          const user = userSchema.safeParse(
            await fetchJson(
              fetch,
              new Request('https://littleskin.cn/api/user', {
                headers: { Accept: 'application/json', Authorization: `Bearer ${token.data.access_token}` },
              }),
              'user',
            ),
          )
          if (!user.success) throw new Error('invalid user response')
          return {
            subject: String(user.data.uid),
            email: user.data.email ?? null,
            emailVerified: user.data.verified === true || user.data.verified === 1,
            displayName: user.data.nickname ?? null,
          }
        },
      },
    ],
  },
})
