import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { DomainError, type Core } from '@nextskin/domain'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'
import type { RateLimiter } from './rate-limit.ts'
import { requireSession } from './session.ts'

const errorContent = { description: '请求失败', content: { 'application/json': { schema: errorSchema } } }
const errors = {
  400: errorContent,
  401: errorContent,
  403: errorContent,
  409: errorContent,
  413: errorContent,
  415: errorContent,
  500: errorContent,
}
const limited = { ...errorContent, headers: z.object({ 'Retry-After': z.string() }) }
const userSchema = z.object({
  uid: z.number().int(),
  nickname: z.string(),
  role: z.enum(['banned', 'user', 'admin', 'superadmin']),
  avatarTid: z.number().int().nullable(),
  registeredAt: z.string().datetime(),
  email: z.string(),
  emailVerified: z.boolean(),
  score: z.number().int(),
  locale: z.string().nullable(),
})
const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { 'application/json': { schema } } })
const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})
const profile = createRoute({
  method: 'patch',
  path: '/user',
  request: { body: jsonBody(z.object({ nickname: z.string().optional(), locale: z.string().optional() })) },
  responses: { 200: jsonResponse(userSchema, '个人资料已保存'), ...errors },
})
const email = createRoute({
  method: 'post',
  path: '/user/email',
  request: { body: jsonBody(z.object({ email: z.string(), password: z.string() })) },
  responses: {
    200: jsonResponse(userSchema, '邮箱已修改'),
    202: jsonResponse(z.object({ pendingEmail: z.string() }), '确认邮件已入队'),
    429: limited,
    ...errors,
  },
})
const confirm = createRoute({
  method: 'post',
  path: '/user/email/confirm',
  request: { body: jsonBody(z.object({ token: z.string() })) },
  responses: { 200: jsonResponse(z.object({ email: z.string() }), '新邮箱已确认'), ...errors },
})
const deleted = createRoute({
  method: 'delete',
  path: '/user',
  request: { body: jsonBody(z.object({ password: z.string() })) },
  responses: {
    200: { ...jsonResponse(z.object({}), '账号已删除'), headers: z.object({ 'Set-Cookie': z.string() }) },
    429: limited,
    ...errors,
  },
})

export function registerUser(app: OpenAPIHono<AppEnv>, core: Core, limiter: RateLimiter) {
  const session = requireSession(core)
  app.patch('/user', session)
  app.post('/user/email', session)
  app.delete('/user', session)
  async function limit(uid: number) {
    // 改邮箱和删除账号共用一个窗口，切换端点不能获得额外的猜密码次数。
    const result = await limiter.consume(String(uid))
    if (!result.allowed) throw new DomainError('too_many_requests', { retryAfter: result.retryAfter })
  }
  app.openapi(profile, async (c) =>
    c.json(await core.users.updateProfile({ uid: c.get('user')!.uid }, c.req.valid('json')), 200),
  )
  app.openapi(email, async (c) => {
    const uid = c.get('user')!.uid
    await limit(uid)
    const result = await core.users.changeEmail({ uid }, c.req.valid('json'), c.get('requestRoot'))
    return result.status === 'pending' ? c.json({ pendingEmail: result.pendingEmail }, 202) : c.json(result.user, 200)
  })
  app.openapi(confirm, async (c) => c.json(await core.users.confirmEmailChange(c.req.valid('json').token), 200))
  app.openapi(deleted, async (c) => {
    const uid = c.get('user')!.uid
    await limit(uid)
    await core.users.deleteAccount({ uid }, c.req.valid('json'))
    for (const cookie of await core.auth.clearSessionCookies(c.req.raw.headers, c.get('requestRoot')))
      c.header('Set-Cookie', cookie, { append: true })
    return c.json({}, 200)
  })
}
