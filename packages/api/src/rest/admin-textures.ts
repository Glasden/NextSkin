import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { AdminActor, Core } from '@nextskin/domain'
import type { Context } from 'hono'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'
import { texture } from './textures.ts'

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
const params = z.object({
  tid: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().positive().max(2147483647)),
})
const update = createRoute({
  method: 'patch',
  path: '/admin/textures/{tid}',
  request: {
    params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z
            .object({
              name: z.string().optional(),
              type: z.enum(['steve', 'alex', 'cape']).optional(),
              description: z.string().nullable().optional(),
            })
            .refine((body) => body.name !== undefined || body.type !== undefined || body.description !== undefined),
        },
      },
    },
  },
  responses: { 200: { description: '材质已更新', content: { 'application/json': { schema: texture } } }, ...errors },
})
const unpublish = createRoute({
  method: 'post',
  path: '/admin/textures/{tid}/unpublish',
  request: { params },
  responses: { 200: { description: '材质已下架', content: { 'application/json': { schema: texture } } }, ...errors },
})

/** 会话由 registerAdmin 检查，权限和上传者在用例里按数据库现值判断。 */
export function registerAdminTextures(app: OpenAPIHono<AppEnv>, core: Core) {
  const actor = async (c: Context<AppEnv>): Promise<AdminActor> => ({
    uid: c.get('user')!.uid,
    ip: await clientIp(c, core),
  })
  app.openapi(update, async (c) =>
    c.json(await core.admin.updateTexture(await actor(c), c.req.valid('param').tid, c.req.valid('json')), 200),
  )
  app.openapi(unpublish, async (c) =>
    c.json(await core.admin.unpublishTexture(await actor(c), c.req.valid('param').tid), 200),
  )
}
