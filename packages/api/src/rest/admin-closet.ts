import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { AdminActor, Core } from '@nextskin/domain'
import type { Context } from 'hono'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'

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
const bodyId = z.number().int().positive().max(2147483647)
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(bodyId)
/** 后台衣柜项：别人的私有材质在操作者没有 textures.manage 时不给衣柜名和材质（ADR-0036"别人的材质"） */
const item = z.object({
  tid: z.number().int(),
  name: z.string().nullable(),
  scorePaid: z.number().int(),
  addedAt: z.iso.datetime(),
  visibleToOwner: z.boolean(),
  texture: z
    .object({
      name: z.string(),
      type: z.enum(['steve', 'alex', 'cape']),
      hash: z.string(),
      scale: z.number(),
      public: z.boolean(),
    })
    .nullable(),
})
const add = createRoute({
  method: 'post',
  path: '/admin/users/{uid}/closet',
  request: {
    params: z.object({ uid: id }),
    body: {
      required: true,
      content: { 'application/json': { schema: z.object({ tid: bodyId, name: z.string().optional() }) } },
    },
  },
  responses: { 201: { description: '已加入衣柜', content: { 'application/json': { schema: item } } }, ...errors },
})
const remove = createRoute({
  method: 'delete',
  path: '/admin/users/{uid}/closet/{tid}',
  request: { params: z.object({ uid: id, tid: id }) },
  responses: {
    200: {
      description: '已移出衣柜',
      content: { 'application/json': { schema: z.object({ refunded: z.number().int() }) } },
    },
    ...errors,
  },
})

/** 事件的 actor 来自管理员会话，衣柜主人单独作为用例参数。 */
export function registerAdminCloset(app: OpenAPIHono<AppEnv>, core: Core) {
  const actor = async (c: Context<AppEnv>): Promise<AdminActor> => ({
    uid: c.get('user')!.uid,
    ip: await clientIp(c, core),
  })
  app.openapi(add, async (c) =>
    c.json(await core.admin.addClosetItem(await actor(c), c.req.valid('param').uid, c.req.valid('json')), 201),
  )
  app.openapi(remove, async (c) =>
    c.json(await core.admin.removeClosetItem(await actor(c), c.req.valid('param').uid, c.req.valid('param').tid), 200),
  )
}
