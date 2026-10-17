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
  413: errorContent,
  415: errorContent,
  500: errorContent,
}
const playerSchema = z.object({
  pid: z.number().int(),
  uid: z.number().int(),
  name: z.string(),
  uuid: z.string(),
  skin: z.number().int().nullable(),
  cape: z.number().int().nullable(),
  updatedAt: z.string().datetime(),
})
const body = { required: true, content: { 'application/json': { schema: z.object({ name: z.string() }) } } }
const params = z.object({
  pid: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
})
const created = createRoute({
  method: 'post',
  path: '/players',
  request: { body },
  responses: {
    201: { description: '角色已添加', content: { 'application/json': { schema: playerSchema } } },
    ...errors,
  },
})
const renamed = createRoute({
  method: 'patch',
  path: '/players/{pid}',
  request: { params, body },
  responses: {
    200: { description: '角色已改名', content: { 'application/json': { schema: playerSchema } } },
    ...errors,
  },
})
const deleted = createRoute({
  method: 'delete',
  path: '/players/{pid}',
  request: { params },
  responses: {
    200: {
      description: '角色已删除',
      content: { 'application/json': { schema: z.object({ refunded: z.number().int() }) } },
    },
    ...errors,
  },
})

export function registerPlayers(app: OpenAPIHono<AppEnv>, core: Core) {
  const session = requireSession(core)
  app.post('/players', session)
  app.patch('/players/:pid', session)
  app.delete('/players/:pid', session)
  app.openapi(created, async (c) =>
    c.json(await core.players.create({ uid: c.get('user')!.uid }, c.req.valid('json')), 201),
  )
  app.openapi(renamed, async (c) =>
    c.json(await core.players.rename({ uid: c.get('user')!.uid }, c.req.valid('param').pid, c.req.valid('json')), 200),
  )
  app.openapi(deleted, async (c) =>
    c.json(await core.players.delete({ uid: c.get('user')!.uid }, c.req.valid('param').pid), 200),
  )
}
