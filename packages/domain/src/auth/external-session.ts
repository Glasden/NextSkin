import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, createAuthMiddleware, freshSessionMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { z } from 'zod'

/**
 * 第三方登录要用的 Better Auth 端点（ADR-0034）。都只能在服务端调用：HTTP 的入口在 `packages/api` 的
 * `/api/external-login/*`，那里由领域层处理 state、绑定和注册，这里只做 Better Auth 才能做的事。
 *
 * - 签发会话：和密码登录一样建会话、写 Cookie。开了两步验证时直接调用两步验证插件的 after 钩子：
 *   它的 matcher 只认密码登录的路径，handler 本身不看路径。它删掉刚建的会话，换成第二步的挑战（同一个 Cookie、
 *   同样的验证记录），"信任这台设备"也照样有效。依赖钩子的结构（`hooks.after[0].handler`），升级 Better Auth 时
 *   由"第三方登录也要过第二步"的测试守住。
 * - 会话是不是刚登录的：绑定第三方账号、设置密码之前检查（`session.freshAge`，ADR-0023）。
 * - Better Auth 自带的第三方登录（`/sign-in/social`、`/callback/:id`）一律 404：`disabledPaths` 只按完整路径匹配，
 *   挡不住带参数的回调路径。
 */
export function externalSession() {
  return {
    id: 'nextskin-external-session',
    endpoints: {
      externalSignIn: createAuthEndpoint.serverOnly(
        { method: 'POST', body: z.object({ uid: z.number().int() }) },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(String(ctx.body.uid))
          if (!user) throw new APIError('BAD_REQUEST', { code: 'USER_NOT_FOUND' })
          // 和密码登录勾选"记住我"时相同
          const session = await ctx.context.internalAdapter.createSession(user.id, false)
          if (!(user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) {
            await setSessionCookie(ctx, { session, user }, false)
            return ctx.json({ twoFactorRedirect: false })
          }
          const handler = ctx.context.options.plugins?.find((plugin) => plugin.id === 'two-factor')?.hooks?.after?.[0]
            ?.handler as ((input: unknown) => Promise<{ headers?: Headers | null } | undefined>) | undefined
          // 找不到钩子就不能放行：宁可让这次登录失败
          if (!handler) {
            await ctx.context.internalAdapter.deleteSession(session.token)
            throw new APIError('INTERNAL_SERVER_ERROR', { code: 'TWO_FACTOR_HOOK_MISSING' })
          }
          // 会话的 Cookie 还没写：钩子删掉会话、换成第二步的挑战时，响应里不会出现有效的会话令牌
          ctx.context.setNewSession({ session, user })
          const result = await handler({ ...ctx, returnHeaders: true })
          // 钩子设的 Cookie（第二步的挑战，或者轮换过的"信任这台设备"）合进这次的响应
          const headers = (ctx as unknown as { responseHeaders: Headers }).responseHeaders
          for (const cookie of result?.headers?.getSetCookie() ?? []) headers.append('set-cookie', cookie)
          // 认出了信任过的设备，钩子就留着会话
          if (!ctx.context.newSession) return ctx.json({ twoFactorRedirect: true })
          await setSessionCookie(ctx, { session, user }, false)
          return ctx.json({ twoFactorRedirect: false })
        },
      ),
      freshSession: createAuthEndpoint.serverOnly({ method: 'GET', use: [freshSessionMiddleware] }, async (ctx) =>
        ctx.json({ uid: Number(ctx.context.session.user.id) }),
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/sign-in/social' || ctx.path === '/callback/:id',
          handler: createAuthMiddleware(() => Promise.reject(new APIError('NOT_FOUND'))),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
