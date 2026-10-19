import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import {
  DomainError,
  EXTERNAL_PENDING_TTL_SECONDS,
  EXTERNAL_STATE_TTL_SECONDS,
  type Core,
  type ExternalCallbackResult,
} from '@nextskin/domain'
import { LOCALE_COOKIE, matchAcceptLanguage, matchLocale } from '@nextskin/i18n'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { safeNextPath } from '../next-path.ts'
import { createErrorResponse, errorSchema, logError } from './errors.ts'
import { requireSession } from './session.ts'

/**
 * 第三方登录的 HTTP 入口（ADR-0034）：发起、回调、完成注册、解绑、给没有密码的账号设置密码。
 * state 和暂存的身份由领域层保存，这里只管 Cookie 和跳转；会话由 Better Auth 签发（auth/external-session.ts）。
 *
 * - state 的 Cookie 只发给回调地址；暂存身份的 Cookie 要让"完成注册"页读到，所以放在根路径。
 *   两个都是 SameSite=Lax：第三方把浏览器跳回回调地址是跨站的顶层导航，Strict 的 Cookie 带不过来。
 * - 回调只做跳转，出错时带着错误码回到登录页或安全页，由页面显示文案。
 */
export const EXTERNAL_STATE_COOKIE = 'nextskin-external-state'
export const EXTERNAL_PENDING_COOKIE = 'nextskin-external-pending'
const STATE_COOKIE_PATH = '/api/external-login/'
/** 回调的查询串比这更长就不交给插件：正常的授权码、state 远远用不到 */
const MAX_CALLBACK_QUERY_LENGTH = 8192

const errorContent = { content: { 'application/json': { schema: errorSchema } }, description: 'Request failed' }
const errors = {
  400: errorContent,
  401: errorContent,
  403: errorContent,
  404: errorContent,
  409: errorContent,
  413: errorContent,
  415: errorContent,
  500: errorContent,
  502: errorContent,
  503: errorContent,
  504: errorContent,
}
/** 插件 id、Provider id 的格式由 manifest 校验，这里只挡住明显不对的值 */
const idParam = z.string().min(1).max(64)
const providerParams = z.object({ pluginId: idParam, providerId: idParam })
const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { 'application/json': { schema } } })

const start = createRoute({
  method: 'post',
  path: '/external-login/{pluginId}/{providerId}',
  request: {
    params: providerParams,
    body: jsonBody(z.object({ intent: z.enum(['signIn', 'link']), next: z.string().optional() })),
  },
  responses: {
    200: {
      description: '第三方授权页的地址，state 写进了 Cookie',
      content: { 'application/json': { schema: z.object({ url: z.string() }) } },
    },
    ...errors,
  },
})
const complete = createRoute({
  method: 'post',
  path: '/external-login/complete',
  request: {
    body: jsonBody(
      z.object({
        email: z.string(),
        nickname: z.string().optional(),
        playerName: z.string().optional(),
        /** 插件加在注册表单上的字段：按插件 id 分组（ADR-0033） */
        plugins: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
      }),
    ),
  },
  responses: {
    201: {
      description: '账号已建好并绑定了第三方账号',
      content: {
        'application/json': {
          schema: z.object({ uid: z.number().int(), signedIn: z.boolean(), next: z.string() }),
        },
      },
    },
    ...errors,
  },
})
const unlink = createRoute({
  method: 'delete',
  path: '/user/bindings/{pluginId}/{providerId}',
  request: { params: providerParams },
  responses: {
    200: { description: '已解绑', content: { 'application/json': { schema: z.object({}) } } },
    ...errors,
  },
})
const password = createRoute({
  method: 'post',
  path: '/user/password',
  request: { body: jsonBody(z.object({ password: z.string() })) },
  responses: {
    200: { description: '密码已设置', content: { 'application/json': { schema: z.object({}) } } },
    ...errors,
  },
})

/** 回调地址要和发起时交给第三方的完全一致，所以按站点地址拼，不按这次请求的 Host */
async function siteUrl(c: Context<AppEnv>, core: Core): Promise<string> {
  const values = await core.settings.read(['site.url'])
  return values['site.url'].replace(/\/+$/, '') || c.get('requestRoot')
}

function cookieOptions(c: Context<AppEnv>, path: string, maxAge: number) {
  return { httpOnly: true, sameSite: 'Lax', path, maxAge, secure: c.get('requestRoot').startsWith('https:') } as const
}

function requestLocale(c: Context<AppEnv>) {
  return matchLocale(getCookie(c, LOCALE_COOKIE) ?? '') ?? matchAcceptLanguage(c.req.header('accept-language') ?? '')
}

/** 回调出错时显示文案的页面：发起绑定的回到安全页，其余回到登录页 */
function errorLocation(code: string, intent: unknown, signedIn: boolean): string {
  // state 对不上时不知道是在登录还是在绑定；登录页不对已登录的用户开放，已登录的多半是在绑定
  const link = intent === 'link' || (intent === undefined && signedIn)
  return `${link ? '/user/security' : '/sign-in'}?error=${encodeURIComponent(code)}`
}

export function registerExternalLogin(app: OpenAPIHono<AppEnv>, core: Core) {
  const errorResponse = createErrorResponse(core)
  const session = requireSession(core)
  app.delete('/user/bindings/*', session)
  app.post('/user/password', session)

  app.openapi(start, async (c) => {
    const { pluginId, providerId } = c.req.valid('param')
    const body = c.req.valid('json')
    let session: { uid: number; sessionId: number } | null = null
    if (body.intent === 'link') {
      const user = await core.auth.getSessionUser(c.req.raw.headers, c.get('requestRoot'))
      if (!user) return errorResponse(c, 'unauthenticated')
      // 偷到会话 Cookie 的人不能给账号加一个自己的第三方账号（ADR-0034"绑定和解绑"）
      if (!(await core.auth.isFreshSession(c.req.raw.headers, c.get('requestRoot'))))
        return errorResponse(c, 'session_not_fresh')
      session = { uid: user.uid, sessionId: user.sessionId }
    }
    const result = await core.externalLogin.start({
      pluginId,
      providerId,
      intent: body.intent,
      // 绑定认的是发起它的那个会话：回调时必须还是它，写绑定时在锁内确认它没被作废（ADR-0036）
      uid: session?.uid ?? null,
      sessionId: session?.sessionId ?? null,
      next: body.intent === 'link' ? '/user/security' : safeNextPath(body.next),
      siteUrl: await siteUrl(c, core),
      locale: requestLocale(c) ?? undefined,
    })
    setCookie(c, EXTERNAL_STATE_COOKIE, result.state, cookieOptions(c, STATE_COOKIE_PATH, EXTERNAL_STATE_TTL_SECONDS))
    return c.json({ url: result.url }, 200)
  })

  app.get('/external-login/:pluginId/:providerId/callback', async (c) => {
    const cookieState = getCookie(c, EXTERNAL_STATE_COOKIE) ?? null
    deleteCookie(c, EXTERNAL_STATE_COOKIE, { path: STATE_COOKIE_PATH })
    c.header('Referrer-Policy', 'no-referrer')
    const root = c.get('requestRoot')
    const sessionUser = await core.auth.getSessionUser(c.req.raw.headers, root)
    let result: ExternalCallbackResult
    try {
      if (new URL(c.req.url).search.length > MAX_CALLBACK_QUERY_LENGTH) throw new DomainError('external_login_failed')
      result = await core.externalLogin.callback({
        pluginId: c.req.param('pluginId'),
        providerId: c.req.param('providerId'),
        query: c.req.query(),
        cookieState,
        sessionUid: sessionUser?.uid ?? null,
        sessionId: sessionUser?.sessionId ?? null,
        siteUrl: await siteUrl(c, core),
        locale: requestLocale(c) ?? undefined,
      })
    } catch (error) {
      if (!(error instanceof DomainError)) logError(error)
      const code = error instanceof DomainError ? error.code : 'external_login_failed'
      return c.redirect(
        errorLocation(code, error instanceof DomainError ? error.params?.intent : undefined, !!sessionUser),
        303,
      )
    }
    if (result.kind === 'linked') return c.redirect(`${result.next}?linked=1`, 303)
    if (result.kind === 'register') {
      setCookie(c, EXTERNAL_PENDING_COOKIE, result.pendingToken, cookieOptions(c, '/', EXTERNAL_PENDING_TTL_SECONDS))
      return c.redirect('/sign-in/complete', 303)
    }
    const ip = await clientIp(c, core)
    let signedIn: { cookies: string[]; twoFactor: boolean }
    try {
      if (ip === null) throw new DomainError('service_unavailable')
      signedIn = await core.auth.createExternalSession({
        uid: result.uid,
        headers: c.req.raw.headers,
        clientIp: ip,
        requestRoot: root,
      })
    } catch (error) {
      if (!(error instanceof DomainError)) logError(error)
      return c.redirect(errorLocation('external_login_failed', 'signIn', false), 303)
    }
    for (const cookie of signedIn.cookies) c.header('Set-Cookie', cookie, { append: true })
    return c.redirect(
      signedIn.twoFactor ? `/sign-in/two-factor?next=${encodeURIComponent(result.next)}` : result.next,
      303,
    )
  })

  app.openapi(complete, async (c) => {
    const ip = await clientIp(c, core)
    if (ip === null) return errorResponse(c, 'service_unavailable')
    const token = getCookie(c, EXTERNAL_PENDING_COOKIE) ?? null
    const { uid, next } = await core.externalLogin.complete(token, {
      ...c.req.valid('json'),
      ip,
      locale: requestLocale(c),
    })
    deleteCookie(c, EXTERNAL_PENDING_COOKIE, { path: '/' })
    let cookies: string[]
    try {
      // 新账号不会开着两步验证
      cookies = (
        await core.auth.createExternalSession({
          uid,
          headers: c.req.raw.headers,
          clientIp: ip,
          requestRoot: c.get('requestRoot'),
        })
      ).cookies
    } catch (error) {
      logError(error)
      return c.json({ uid, signedIn: false, next }, 201)
    }
    for (const cookie of cookies) c.header('Set-Cookie', cookie, { append: true })
    return c.json({ uid, signedIn: true, next }, 201)
  })

  app.openapi(unlink, async (c) => {
    const { pluginId, providerId } = c.req.valid('param')
    await core.externalLogin.unlink(c.get('user')!.uid, pluginId, providerId)
    return c.json({}, 200)
  })

  app.openapi(password, async (c) => {
    const uid = c.get('user')!.uid
    const root = c.get('requestRoot')
    if (await core.externalLogin.hasPassword(uid)) return errorResponse(c, 'password_already_set')
    if (!(await core.auth.isFreshSession(c.req.raw.headers, root))) return errorResponse(c, 'session_not_fresh')
    await core.auth.setPassword({
      uid,
      headers: c.req.raw.headers,
      password: c.req.valid('json').password,
      requestRoot: root,
    })
    return c.json({}, 200)
  })
}
