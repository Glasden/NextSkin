import { normalizePathname } from '@better-auth/core/utils/url'
import type { BetterAuthPlugin } from 'better-auth'
import { CAPTCHA_HEADER, type CaptchaService } from '../captcha/service.ts'
import { DomainError } from '../errors.ts'
import { AUTH_BASE_PATH, CLIENT_IP_HEADER } from './auth.ts'

const errors = {
  captcha_required: { status: 400, message: 'Please complete the captcha.' },
  captcha_failed: { status: 403, message: 'Captcha verification failed. Please try again.' },
  captcha_unavailable: { status: 503, message: 'Captcha verification is unavailable. Please try again later.' },
} as const

/** onRequest 只经过 HTTP；注册后经 auth.api 签发会话不再核对一次（ADR-0038）。 */
export function captchaGuard(captcha?: Pick<CaptchaService, 'verify'>) {
  return {
    id: 'nextskin-captcha' as const,
    async onRequest(request, ctx) {
      // 和 Better Auth 的路由用同一个 basePath、同一种规范化：site.url 带路径时它的 basePath 就是那个路径，
      // 按固定的 /api/auth 去前缀会认不出要拦的端点
      const basePath = ctx.baseURL ? new URL(ctx.baseURL).pathname : AUTH_BASE_PATH
      const path = normalizePathname(request.url, basePath)
      if (request.method !== 'POST' || !['/sign-in/email', '/request-password-reset'].includes(path)) return
      try {
        await captcha?.verify({
          token: request.headers.get(CAPTCHA_HEADER),
          ip: request.headers.get(CLIENT_IP_HEADER),
        })
      } catch (error) {
        if (!(error instanceof DomainError) || !Object.hasOwn(errors, error.code)) throw error
        const code = error.code as keyof typeof errors
        const { status, message } = errors[code]
        return { response: Response.json({ code, message }, { status }) }
      }
    },
  } satisfies BetterAuthPlugin
}
