import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { Core } from '@nextskin/domain'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'
import { requireSession } from './session.ts'

const errorContent = { description: '请求失败', content: { 'application/json': { schema: errorSchema } } }
const create = createRoute({
  method: 'post',
  path: '/reports',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ tid: z.number().int().positive().max(2147483647), reason: z.string() }),
        },
      },
    },
  },
  responses: {
    201: {
      description: '举报已提交',
      content: {
        'application/json': {
          schema: z.object({
            id: z.number().int(),
            tid: z.number().int(),
            reason: z.string(),
            status: z.enum(['pending', 'resolved', 'rejected']),
            scorePaid: z.number().int(),
            createdAt: z.iso.datetime(),
          }),
        },
      },
    },
    400: errorContent,
    401: errorContent,
    403: errorContent,
    404: errorContent,
    409: errorContent,
    413: errorContent,
    415: errorContent,
    500: errorContent,
  },
})
export function registerReports(app: OpenAPIHono<AppEnv>, core: Core) {
  app.post('/reports', requireSession(core))
  app.openapi(create, async (c) =>
    c.json(await core.reports.create({ uid: c.get('user')!.uid }, c.req.valid('json')), 201),
  )
}
