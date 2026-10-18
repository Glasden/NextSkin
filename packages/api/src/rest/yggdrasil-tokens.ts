import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { Core } from '@nextskin/domain'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'
import { requireSession } from './session.ts'

const errorContent = { content: { 'application/json': { schema: errorSchema } }, description: '请求失败' }
const errors = {
  400: errorContent,
  401: errorContent,
  403: errorContent,
  413: errorContent,
  415: errorContent,
  500: errorContent,
}
const path = '/user/yggdrasil-tokens'
const list = createRoute({
  method: 'get',
  path,
  responses: {
    200: {
      description: '当前用户的启动器登录',
      content: {
        'application/json': {
          schema: z.object({
            tokens: z.array(
              z.object({
                id: z.number().int(),
                createdAt: z.iso.datetime(),
                validUntil: z.iso.datetime(),
                expiresAt: z.iso.datetime(),
                player: z.object({ pid: z.number().int(), name: z.string() }).nullable(),
                status: z.enum(['valid', 'refreshable']),
              }),
            ),
          }),
        },
      },
    },
    ...errors,
  },
})
const revoke = createRoute({
  method: 'delete',
  path: `${path}/{id}`,
  request: {
    params: z.object({
      id: z
        .string()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
    }),
  },
  responses: { 204: { description: '已退出启动器登录' }, ...errors },
})
const revokeAll = createRoute({
  method: 'delete',
  path,
  responses: { 204: { description: '已退出全部启动器登录' }, ...errors },
})

export function registerYggdrasilTokens(app: OpenAPIHono<AppEnv>, core: Core) {
  const session = requireSession(core)
  app.get(path, session)
  app.delete(path, session)
  app.delete(`${path}/:id`, session)
  app.openapi(list, async (c) => c.json({ tokens: await core.yggdrasil.listTokens(c.get('user')!.uid) }, 200))
  app.openapi(revoke, async (c) => {
    await core.yggdrasil.revokeToken(c.get('user')!.uid, c.req.valid('param').id)
    return c.body(null, 204)
  })
  app.openapi(revokeAll, async (c) => {
    await core.yggdrasil.revokeAllTokens(c.get('user')!.uid)
    return c.body(null, 204)
  })
}
