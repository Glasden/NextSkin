/**
 * GitHub 登录（BS 的 oauth-github，ADR-0034）。
 *
 * GitHub OAuth App 的授权码流程，带 PKCE。身份取自 `/user` 和 `/user/emails`：subject 用数字 id（登录名可以改），
 * 邮箱取 primary 的那一个，它是否验证过就是 `emailVerified`。不申请任何能力，只访问 GitHub 的两个域名。
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
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().min(1),
  name: z.string().nullish(),
})
const emailsSchema = z.array(z.object({ email: z.string().min(1), primary: z.boolean(), verified: z.boolean() }))

export default definePlugin({
  capabilities: [],
  network: ['https://github.com', 'https://api.github.com'],
  settings,
  providers: {
    login: [
      {
        id: 'github',
        label: 'login.github',
        icon: 'github',
        async authorizeUrl({ state, codeChallenge, redirectUri, ctx }) {
          return authorizationUrl(
            'https://github.com/login/oauth/authorize',
            { clientId: ctx.settings.clientId, state, codeChallenge, redirectUri },
            { scope: 'read:user user:email' },
          )
        },
        async exchange({ query, codeVerifier, redirectUri, ctx }) {
          const fetch = (...args: Parameters<typeof ctx.fetch>) => ctx.fetch(...args)
          const token = tokenSchema.safeParse(
            await exchangeCode(fetch, 'https://github.com/login/oauth/access_token', {
              query,
              codeVerifier,
              redirectUri,
              ...ctx.settings,
            }),
          )
          if (!token.success) throw new Error('invalid token response')
          const headers = {
            Authorization: `Bearer ${token.data.access_token}`,
            'User-Agent': 'NextSkin',
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          }
          const user = userSchema.safeParse(
            await fetchJson(fetch, new Request('https://api.github.com/user', { headers }), 'user'),
          )
          if (!user.success) throw new Error('invalid user response')
          const emails = emailsSchema.safeParse(
            await fetchJson(fetch, new Request('https://api.github.com/user/emails', { headers }), 'user'),
          )
          if (!emails.success) throw new Error('invalid user response')
          const primary = emails.data.find((email) => email.primary)
          return {
            // 登录名和邮箱都能改，只有数字 id 能保持已有绑定有效。
            subject: String(user.data.id),
            email: primary?.email ?? null,
            emailVerified: primary?.verified === true,
            displayName: user.data.name?.trim() ? user.data.name : user.data.login,
          }
        },
      },
    ],
  },
})
