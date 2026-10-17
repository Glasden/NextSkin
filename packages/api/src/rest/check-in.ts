import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { Core } from '@nextskin/domain'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'
import { requireSession } from './session.ts'

const errorContent = { content: { 'application/json': { schema: errorSchema } }, description: '请求失败' }
const route = createRoute({
  method: 'post',
  path: '/user/check-in',
  responses: {
    200: {
      description: '签到成功',
      content: {
        'application/json': {
          schema: z.object({
            delta: z.number().int(),
            score: z.number().int(),
            nextAt: z.string().datetime().nullable(),
          }),
        },
      },
    },
    400: errorContent,
    401: errorContent,
    403: errorContent,
    409: errorContent,
    413: errorContent,
    415: errorContent,
    500: errorContent,
  },
})

export function registerCheckIn(app: OpenAPIHono<AppEnv>, core: Core) {
  app.post('/user/check-in', requireSession(core))
  app.openapi(route, async (c) => c.json(await core.users.checkIn({ uid: c.get('user')!.uid }), 200))
}
