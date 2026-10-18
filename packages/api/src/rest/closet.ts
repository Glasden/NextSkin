import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { Core } from '@nextskin/domain'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'
import { requireSession } from './session.ts'

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
const tid = z.number().int().positive().max(2147483647)
const params = z.object({
  tid: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(tid),
})
const item = z.object({
  tid: z.number().int(),
  name: z.string(),
  textureName: z.string(),
  type: z.enum(['steve', 'alex', 'cape']),
  hash: z.string(),
  scale: z.number(),
  public: z.boolean(),
  scorePaid: z.number().int(),
  addedAt: z.iso.datetime(),
})
const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { 'application/json': { schema } } })
const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})
const list = createRoute({
  method: 'get',
  path: '/closet',
  request: {
    query: z.object({
      type: z.enum(['skin', 'cape']).default('skin'),
      q: z.string().max(64).optional(),
      page: z
        .string()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
        .default(1),
    }),
  },
  responses: { 200: jsonResponse(z.object({ items: z.array(item), total: z.number().int() }), '衣柜'), ...errors },
})
const add = createRoute({
  method: 'post',
  path: '/closet',
  request: { body: jsonBody(z.object({ tid, name: z.string().optional() })) },
  responses: { 201: jsonResponse(item, '已加入衣柜'), ...errors },
})
const rename = createRoute({
  method: 'patch',
  path: '/closet/{tid}',
  request: { params, body: jsonBody(z.object({ name: z.string() })) },
  responses: { 200: jsonResponse(item, '已改名'), ...errors },
})
const remove = createRoute({
  method: 'delete',
  path: '/closet/{tid}',
  request: { params },
  responses: { 200: jsonResponse(z.object({ refunded: z.number().int() }), '已移出衣柜'), ...errors },
})

export function registerCloset(app: OpenAPIHono<AppEnv>, core: Core) {
  const session = requireSession(core)
  app.get('/closet', session)
  app.post('/closet', session)
  app.patch('/closet/:tid', session)
  app.delete('/closet/:tid', session)
  app.openapi(list, async (c) => c.json(await core.closet.list(c.get('user')!.uid, c.req.valid('query')), 200))
  app.openapi(add, async (c) => c.json(await core.closet.add({ uid: c.get('user')!.uid }, c.req.valid('json')), 201))
  app.openapi(rename, async (c) =>
    c.json(await core.closet.rename({ uid: c.get('user')!.uid }, c.req.valid('param').tid, c.req.valid('json')), 200),
  )
  app.openapi(remove, async (c) =>
    c.json(await core.closet.remove({ uid: c.get('user')!.uid }, c.req.valid('param').tid), 200),
  )
}
