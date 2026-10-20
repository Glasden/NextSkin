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
  404: errorContent,
  409: errorContent,
  410: errorContent,
  413: errorContent,
  415: errorContent,
  429: errorContent,
  500: errorContent,
}
const userCode = z.string().min(1).max(64)
const approve = createRoute({
  method: 'post',
  path: '/user/device/approve',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ userCode, pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable() }),
        },
      },
    },
  },
  responses: { 204: { description: '已批准设备授权' }, ...errors },
})
const deny = createRoute({
  method: 'post',
  path: '/user/device/deny',
  request: { body: { required: true, content: { 'application/json': { schema: z.object({ userCode }) } } } },
  responses: { 204: { description: '已拒绝设备授权' }, ...errors },
})

export function registerDevices(app: OpenAPIHono<AppEnv>, core: Core) {
  const session = requireSession(core)
  app.post('/user/device/approve', session)
  app.post('/user/device/deny', session)
  app.openapi(approve, async (c) => {
    await core.oauth.approveDevice(c.get('user')!.uid, c.req.valid('json'))
    return c.body(null, 204)
  })
  app.openapi(deny, async (c) => {
    await core.oauth.denyDevice(c.get('user')!.uid, c.req.valid('json'))
    return c.body(null, 204)
  })
}
