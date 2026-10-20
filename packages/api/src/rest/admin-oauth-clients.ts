import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { AdminActor, Core } from '@nextskin/domain'
import type { Context } from 'hono'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'
import { oauthClientSchema } from './oauth-clients.ts'

// 会话由 registerAdmin 挂在 /admin/* 上；权限和主人身份由领域层检查。
const errorContent = { description: '请求失败', content: { 'application/json': { schema: errorSchema } } }
const errors = {
  400: errorContent,
  401: errorContent,
  403: errorContent,
  404: errorContent,
  413: errorContent,
  415: errorContent,
  500: errorContent,
}
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(2147483647))
const params = z.object({ id })
const path = '/admin/oauth-clients'
const schema = oauthClientSchema.extend({
  shared: z.boolean(),
  owner: z
    .object({ uid: z.number().int(), nickname: z.string(), role: z.enum(['banned', 'user', 'admin', 'superadmin']) })
    .nullable(),
})
const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})
const list = createRoute({
  method: 'get',
  path,
  request: {
    query: z.object({ q: z.string().max(255).optional(), owner: id.optional(), page: id.optional().default(1) }),
  },
  responses: {
    200: jsonResponse(
      z.object({
        total: z.number().int(),
        items: z.array(schema),
        owner: z.object({ uid: z.number().int(), nickname: z.string() }).nullable().optional(),
      }),
      '全部 OAuth 应用',
    ),
    ...errors,
  },
})
const disable = createRoute({
  method: 'post',
  path: `${path}/{id}/disable`,
  request: { params },
  responses: { 200: jsonResponse(schema, '应用已停用'), ...errors },
})
const enable = createRoute({
  method: 'post',
  path: `${path}/{id}/enable`,
  request: { params },
  responses: { 200: jsonResponse(schema, '应用已启用'), ...errors },
})
const remove = createRoute({
  method: 'delete',
  path: `${path}/{id}`,
  request: { params },
  responses: { 200: jsonResponse(z.object({}), '应用已删除'), ...errors },
})

export function registerAdminOAuthClients(app: OpenAPIHono<AppEnv>, core: Core) {
  const actor = async (c: Context<AppEnv>): Promise<AdminActor> => ({
    uid: c.get('user')!.uid,
    ip: await clientIp(c, core),
  })
  app.openapi(list, async (c) =>
    c.json(await core.admin.listOAuthClients(c.get('user')!.uid, c.req.valid('query')), 200),
  )
  app.openapi(disable, async (c) =>
    c.json(await core.admin.disableOAuthClient(await actor(c), c.req.valid('param').id), 200),
  )
  app.openapi(enable, async (c) =>
    c.json(await core.admin.enableOAuthClient(await actor(c), c.req.valid('param').id), 200),
  )
  app.openapi(remove, async (c) => {
    await core.admin.deleteOAuthClient(await actor(c), c.req.valid('param').id)
    return c.json({}, 200)
  })
}
