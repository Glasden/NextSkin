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
  413: errorContent,
  415: errorContent,
  500: errorContent,
}
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(2147483647))
const params = z.object({ id })
const uris = z.array(z.string().max(4096)).max(100)
const path = '/oauth-clients'
export const oauthClientSchema = z.object({
  id: z.number().int(),
  clientId: z.string(),
  name: z.string().nullable(),
  type: z.enum(['web', 'native']),
  redirectUris: z.array(z.string()),
  deviceCode: z.boolean(),
  disabled: z.boolean(),
  createdAt: z.iso.datetime(),
  authorizedUsers: z.number().int(),
})
const secretSchema = z.object({ client: oauthClientSchema, clientSecret: z.string() })
const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})
const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { 'application/json': { schema } } })
const list = createRoute({
  method: 'get',
  path,
  responses: { 200: jsonResponse(z.object({ clients: z.array(oauthClientSchema) }), '自己的应用'), ...errors },
})
const create = createRoute({
  method: 'post',
  path,
  request: { body: jsonBody(z.object({ name: z.string(), type: z.enum(['web', 'native']), redirectUris: uris })) },
  responses: {
    201: jsonResponse(secretSchema.extend({ clientSecret: z.string().nullable() }), '应用已创建，密钥只显示一次'),
    ...errors,
  },
})
const update = createRoute({
  method: 'patch',
  path: `${path}/{id}`,
  request: {
    params,
    body: jsonBody(
      z
        .object({ name: z.string().optional(), redirectUris: uris.optional() })
        .refine((body) => body.name !== undefined || body.redirectUris !== undefined),
    ),
  },
  responses: { 200: jsonResponse(oauthClientSchema, '应用已更新'), ...errors },
})
const secret = createRoute({
  method: 'post',
  path: `${path}/{id}/secret`,
  request: { params },
  responses: { 200: jsonResponse(secretSchema, '密钥已重置，只显示一次'), ...errors },
})
const remove = createRoute({
  method: 'delete',
  path: `${path}/{id}`,
  request: { params },
  responses: { 204: { description: '应用已删除' }, ...errors },
})

export function registerOAuthClients(app: OpenAPIHono<AppEnv>, core: Core) {
  const session = requireSession(core)
  app.get(path, session)
  app.post(path, session)
  app.patch(`${path}/:id`, session)
  app.delete(`${path}/:id`, session)
  app.post(`${path}/:id/secret`, session)
  app.openapi(list, async (c) => c.json({ clients: await core.oauth.listClients(c.get('user')!.uid) }, 200))
  app.openapi(create, async (c) => {
    const result = await core.oauth.createClient({ uid: c.get('user')!.uid }, c.req.valid('json'))
    c.header('Cache-Control', 'no-store')
    return c.json(result, 201)
  })
  app.openapi(update, async (c) =>
    c.json(
      await core.oauth.updateClient({ uid: c.get('user')!.uid }, c.req.valid('param').id, c.req.valid('json')),
      200,
    ),
  )
  app.openapi(secret, async (c) => {
    const result = await core.oauth.resetClientSecret({ uid: c.get('user')!.uid }, c.req.valid('param').id)
    c.header('Cache-Control', 'no-store')
    return c.json(result, 200)
  })
  app.openapi(remove, async (c) => {
    await core.oauth.deleteClient({ uid: c.get('user')!.uid }, c.req.valid('param').id)
    return c.body(null, 204)
  })
}
