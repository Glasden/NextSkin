import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { CAPTCHA_HEADER, type Core } from '@nextskin/domain'
import { LOCALE_COOKIE, matchAcceptLanguage, matchLocale } from '@nextskin/i18n'
import { getCookie } from 'hono/cookie'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { createErrorResponse, errorSchema, logError } from './errors.ts'

const errorContent = { content: { 'application/json': { schema: errorSchema } }, description: 'Request failed' }
const route = createRoute({
  method: 'post',
  path: '/register',
  request: {
    headers: z.object({
      [CAPTCHA_HEADER]: z.string().optional().openapi({ description: 'Captcha token (when enabled)' }),
    }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            email: z.string(),
            password: z.string(),
            nickname: z.string().optional(),
            playerName: z.string().optional(),
            /** 插件加在注册表单上的字段：按插件 id 分组（ADR-0033） */
            plugins: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'User registered',
      content: { 'application/json': { schema: z.object({ uid: z.number().int(), signedIn: z.boolean() }) } },
    },
    400: { ...errorContent, description: 'Invalid request or captcha token required' },
    403: { ...errorContent, description: 'Registration denied or captcha verification failed' },
    409: errorContent,
    413: errorContent,
    415: errorContent,
    500: errorContent,
    503: { ...errorContent, description: 'Service or captcha verification unavailable' },
  },
})

export function registerRegistration(app: OpenAPIHono<AppEnv>, core: Core) {
  const errorResponse = createErrorResponse(core)
  app.openapi(route, async (c) => {
    const ip = await clientIp(c, core)
    if (ip === null) return errorResponse(c, 'service_unavailable')
    await core.captcha.verify({ token: c.req.header(CAPTCHA_HEADER) ?? null, ip })
    const body = c.req.valid('json')
    const locale =
      matchLocale(getCookie(c, LOCALE_COOKIE) ?? '') ?? matchAcceptLanguage(c.req.header('accept-language') ?? '')
    const { uid } = await core.users.register({ ...body, ip, locale })
    let cookies: string[]
    try {
      cookies = await core.auth.createSession({
        email: body.email,
        password: body.password,
        clientIp: ip,
        userAgent: c.req.header('user-agent') ?? null,
        requestRoot: c.get('requestRoot'),
      })
    } catch (error) {
      logError(error)
      return c.json({ uid, signedIn: false }, 201)
    }
    for (const cookie of cookies) c.header('Set-Cookie', cookie, { append: true })
    return c.json({ uid, signedIn: true }, 201)
  })
}
