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
const path = '/user/authorizations'
const list = createRoute({
  method: 'get',
  path,
  responses: {
    200: {
      description: '已授权的应用',
      content: {
        'application/json': {
          schema: z.object({
            authorizations: z.array(
              z.object({
                id: z.number().int(),
                client: z.object({
                  id: z.number().int(),
                  clientId: z.string(),
                  name: z.string().nullable(),
                  shared: z.boolean(),
                  owner: z.object({ uid: z.number().int(), nickname: z.string() }).nullable(),
                }),
                scopes: z.array(z.string()),
                players: z.array(z.object({ pid: z.number().int(), name: z.string() })),
                authorizedAt: z.iso.datetime(),
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
  responses: { 204: { description: '已取消授权' }, ...errors },
})

export function registerUserAuthorizations(app: OpenAPIHono<AppEnv>, core: Core) {
  const session = requireSession(core)
  app.get(path, session)
  app.delete(`${path}/:id`, session)
  app.openapi(list, async (c) =>
    c.json({ authorizations: await core.oauth.listAuthorizations(c.get('user')!.uid) }, 200),
  )
  app.openapi(revoke, async (c) => {
    await core.oauth.revokeAuthorization(c.get('user')!.uid, c.req.valid('param').id)
    return c.body(null, 204)
  })
}
