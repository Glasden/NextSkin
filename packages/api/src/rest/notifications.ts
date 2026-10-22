import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { Core } from '@nextskin/domain'
import { LOCALE_COOKIE, resolveLocale } from '@nextskin/i18n'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'
import { requireSession } from './session.ts'

const errorContent = { description: '请求失败', content: { 'application/json': { schema: errorSchema } } }
const errors = {
  400: errorContent,
  401: errorContent,
  403: errorContent,
  404: errorContent,
  409: errorContent,
  413: errorContent,
  415: errorContent,
  500: errorContent,
}
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.int().positive().max(2147483647))
const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})
const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { 'application/json': { schema } } })
const ok = z.object({ ok: z.literal(true) })
const notification = z.object({
  id: z.int(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  format: z.enum(['text', 'markdown']),
  link: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
})
const summary = createRoute({
  method: 'get',
  path: '/notifications/summary',
  responses: { 200: jsonResponse(z.object({ unread: z.int(), latest: z.array(notification) }), '未读摘要'), ...errors },
})
const list = createRoute({
  method: 'get',
  path: '/notifications',
  request: {
    query: z.object({ filter: z.enum(['all', 'unread']).optional().default('all'), page: id.optional().default(1) }),
  },
  responses: {
    200: jsonResponse(
      z.object({ total: z.int(), unread: z.int(), latestId: z.int().nullable(), items: z.array(notification) }),
      '通知列表',
    ),
    ...errors,
  },
})
const read = createRoute({
  method: 'post',
  path: '/notifications/{id}/read',
  request: { params: z.object({ id }) },
  responses: { 200: jsonResponse(ok, '已读'), ...errors },
})
const readAll = createRoute({
  method: 'post',
  path: '/notifications/read-all',
  request: { body: jsonBody(z.object({ through: z.int().positive().max(2147483647) })) },
  responses: { 200: jsonResponse(z.object({ marked: z.int() }), '已标为已读'), ...errors },
})
const remove = createRoute({
  method: 'delete',
  path: '/notifications/{id}',
  request: { params: z.object({ id }) },
  responses: { 200: jsonResponse(ok, '已删除'), ...errors },
})
const broadcasts = createRoute({
  method: 'get',
  path: '/admin/notifications',
  request: { query: z.object({ page: id.optional().default(1) }) },
  responses: {
    200: jsonResponse(
      z.object({
        total: z.int(),
        items: z.array(
          z.object({
            id: z.int(),
            title: z.string(),
            sender: z.object({ uid: z.int(), nickname: z.string() }).nullable(),
            audience: z.enum(['all', 'users', 'admins', 'specific']),
            status: z.enum(['sending', 'sent', 'recalled']),
            recipientCount: z.int(),
            createdAt: z.string(),
            finishedAt: z.string().nullable(),
          }),
        ),
      }),
      '发送记录',
    ),
    ...errors,
  },
})
const send = createRoute({
  method: 'post',
  path: '/admin/notifications',
  request: {
    body: jsonBody(
      z.object({
        audience: z.enum(['all', 'users', 'admins', 'specific']),
        recipients: z.array(z.string()).min(1).max(50).optional(),
        title: z.string(),
        body: z.string(),
      }),
    ),
  },
  responses: { 201: jsonResponse(z.object({ id: z.int() }), '通知已发送'), ...errors },
})
const recall = createRoute({
  method: 'post',
  path: '/admin/notifications/{id}/recall',
  request: { params: z.object({ id }) },
  responses: { 200: jsonResponse(ok, '已撤回'), ...errors },
})

export function registerNotifications(app: OpenAPIHono<AppEnv>, core: Core) {
  const session = requireSession(core)
  app.use('/notifications/*', session)
  async function locale(c: Context<AppEnv>) {
    const values = await core.settings.read(['site.locale'])
    return resolveLocale({
      user: c.get('user')!.locale,
      cookie: getCookie(c, LOCALE_COOKIE),
      acceptLanguage: c.req.header('accept-language'),
      siteDefault: values['site.locale'],
    })
  }
  app.openapi(summary, async (c) => c.json(await core.notifications.summary(c.get('user')!.uid, await locale(c)), 200))
  app.openapi(list, async (c) =>
    c.json(await core.notifications.list(c.get('user')!.uid, await locale(c), c.req.valid('query')), 200),
  )
  app.openapi(readAll, async (c) =>
    c.json({ marked: await core.notifications.markAllRead(c.get('user')!.uid, c.req.valid('json').through) }, 200),
  )
  app.openapi(read, async (c) => {
    await core.notifications.markRead(c.get('user')!.uid, c.req.valid('param').id)
    return c.json({ ok: true as const }, 200)
  })
  app.openapi(remove, async (c) => {
    await core.notifications.remove(c.get('user')!.uid, c.req.valid('param').id)
    return c.json({ ok: true as const }, 200)
  })
}

/** 会话由 registerAdmin 的 /admin/* 中间件检查，权限由领域用例检查。 */
export function registerAdminNotifications(app: OpenAPIHono<AppEnv>, core: Core) {
  const actor = async (c: Context<AppEnv>) => ({ uid: c.get('user')!.uid, ip: await clientIp(c, core) })
  app.openapi(broadcasts, async (c) =>
    c.json(await core.admin.listNotificationBroadcasts(await actor(c), c.req.valid('query')), 200),
  )
  app.openapi(send, async (c) => c.json(await core.admin.sendNotification(await actor(c), c.req.valid('json')), 201))
  app.openapi(recall, async (c) => {
    await core.admin.recallNotification(await actor(c), c.req.valid('param').id)
    return c.json({ ok: true as const }, 200)
  })
}
