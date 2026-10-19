import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { AdminActor, Core } from '@nextskin/domain'
import type { Context } from 'hono'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'

/**
 * 后台的角色管理和转让、换材质用的两个读接口（ADR-0036"接口"）。会话由 registerAdmin 挂在 /admin/* 上的
 * requireSession 检查；权限和"能对谁做"都在用例和查询服务里按库里的身份检查，这里只校验格式。
 */
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
const MAX_ID = 2147483647
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(MAX_ID))
const bodyId = z.number().int().positive().max(MAX_ID)
const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { 'application/json': { schema } } })
const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})
const role = z.enum(['banned', 'user', 'admin', 'superadmin'])
const textureType = z.enum(['steve', 'alex', 'cape'])
const playerSchema = z.object({
  pid: z.number().int(),
  uid: z.number().int(),
  name: z.string(),
  uuid: z.string(),
  skin: z.number().int().nullable(),
  cape: z.number().int().nullable(),
  updatedAt: z.iso.datetime(),
})
const player = z.object({ pid: id })

const update = createRoute({
  method: 'patch',
  path: '/admin/players/{pid}',
  request: {
    params: player,
    body: jsonBody(
      z
        .object({ name: z.string().optional(), skin: bodyId.nullable().optional(), cape: bodyId.nullable().optional() })
        .refine((body) => body.name !== undefined || body.skin !== undefined || body.cape !== undefined),
    ),
  },
  responses: { 200: jsonResponse(playerSchema, '角色已更新'), ...errors },
})
const transfer = createRoute({
  method: 'post',
  path: '/admin/players/{pid}/transfer',
  request: { params: player, body: jsonBody(z.object({ uid: bodyId })) },
  responses: { 200: jsonResponse(playerSchema, '角色已转让，返回转让之后的角色'), ...errors },
})
const remove = createRoute({
  method: 'delete',
  path: '/admin/players/{pid}',
  request: { params: player },
  responses: { 200: jsonResponse(z.object({}), '角色已删除'), ...errors },
})
const lookup = createRoute({
  method: 'get',
  path: '/admin/users/lookup',
  request: {
    // uid 或邮箱，精确匹配；按邮箱查还要有 users.ban
    query: z.object({ q: z.string().min(1).max(255) }),
  },
  responses: {
    200: jsonResponse(
      z.object({
        uid: z.number().int(),
        nickname: z.string(),
        // 没有 users.ban 时为 null
        email: z.string().nullable(),
        role,
        avatar: z.object({ hash: z.string(), scale: z.number() }).nullable(),
      }),
      '查到的用户，只返回身份比自己低的用户',
    ),
    ...errors,
  },
})
const texture = createRoute({
  method: 'get',
  path: '/admin/textures/{tid}',
  request: {
    params: z.object({ tid: id }),
    // 衣柜或角色的主人：要是自己能管理的用户
    query: z.object({ owner: id }),
  },
  responses: {
    200: jsonResponse(
      z.union([
        z.object({
          tid: z.number().int(),
          name: z.string(),
          type: textureType,
          public: z.boolean(),
          uploaderId: z.number().int().nullable(),
          hash: z.string(),
          scale: z.number().nullable(),
          visibleToOwner: z.boolean(),
        }),
        // 别人的私有材质，操作者没有 textures.manage
        z.object({ tid: z.number().int(), public: z.literal(false), visibleToOwner: z.boolean() }),
      ]),
      '材质，以及这个主人能不能用它',
    ),
    ...errors,
  },
})

export function registerAdminPlayers(app: OpenAPIHono<AppEnv>, core: Core) {
  const actor = async (c: Context<AppEnv>): Promise<AdminActor> => ({
    uid: c.get('user')!.uid,
    ip: await clientIp(c, core),
  })
  app.openapi(update, async (c) =>
    c.json(await core.admin.updatePlayer(await actor(c), c.req.valid('param').pid, c.req.valid('json')), 200),
  )
  app.openapi(transfer, async (c) =>
    c.json(await core.admin.transferPlayer(await actor(c), c.req.valid('param').pid, c.req.valid('json').uid), 200),
  )
  app.openapi(remove, async (c) => {
    await core.admin.deletePlayer(await actor(c), c.req.valid('param').pid)
    return c.json({}, 200)
  })
  app.openapi(lookup, async (c) => c.json(await core.admin.lookupUser(c.get('user')!.uid, c.req.valid('query').q), 200))
  app.openapi(texture, async (c) =>
    c.json(
      await core.admin.textureForOwner(c.get('user')!.uid, c.req.valid('param').tid, c.req.valid('query').owner),
      200,
    ),
  )
}
