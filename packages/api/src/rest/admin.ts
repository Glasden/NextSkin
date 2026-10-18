import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { Core } from '@nextskin/domain'
import { clientIp } from '../client-ip.ts'
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
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(2147483647))
const role = z.enum(['banned', 'user', 'admin', 'superadmin'])
const person = z.object({ uid: z.number().int(), nickname: z.string() })
const reportSchema = z.object({
  id: z.number().int(),
  status: z.enum(['pending', 'resolved', 'rejected']),
  resolution: z.enum(['dismissed', 'textureDeleted', 'uploaderBanned']).nullable(),
  reason: z.string(),
  scorePaid: z.number().int(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  texture: z
    .object({
      tid: z.number().int(),
      name: z.string(),
      type: z.enum(['steve', 'alex', 'cape']),
      hash: z.string(),
      scale: z.number(),
      public: z.boolean(),
      likes: z.number().int(),
      pendingReports: z.number().int(),
    })
    .nullable(),
  uploader: person.extend({ role }).nullable(),
  reporter: person.nullable(),
  resolver: z.object({ uid: z.number().int(), nickname: z.string().nullable() }).nullable(),
})
const userSchema = z.object({
  uid: z.number().int(),
  nickname: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  role,
  score: z.number().int(),
  registeredAt: z.iso.datetime(),
  avatar: z.object({ hash: z.string(), scale: z.number() }).nullable(),
})
const resolve = createRoute({
  method: 'post',
  path: '/admin/reports/{id}/resolve',
  request: {
    params: z.object({ id }),
    body: {
      required: true,
      content: {
        'application/json': { schema: z.object({ action: z.enum(['dismiss', 'deleteTexture', 'banUploader']) }) },
      },
    },
  },
  responses: {
    200: { description: '举报已处理', content: { 'application/json': { schema: reportSchema } } },
    ...errors,
  },
})
const remove = createRoute({
  method: 'delete',
  path: '/admin/textures/{tid}',
  request: { params: z.object({ tid: id }) },
  responses: {
    200: {
      description: '材质已删除',
      content: { 'application/json': { schema: z.object({ resolvedReports: z.number().int() }) } },
    },
    ...errors,
  },
})
const setRole = createRoute({
  method: 'patch',
  path: '/admin/users/{uid}',
  request: {
    params: z.object({ uid: id }),
    body: {
      required: true,
      content: { 'application/json': { schema: z.object({ role: z.enum(['banned', 'user', 'admin']) }) } },
    },
  },
  responses: {
    200: { description: '用户角色已更新', content: { 'application/json': { schema: userSchema } } },
    ...errors,
  },
})
export function registerAdmin(app: OpenAPIHono<AppEnv>, core: Core) {
  app.use('/admin/*', requireSession(core))
  app.openapi(resolve, async (c) =>
    c.json(
      await core.admin.resolveReport(
        { uid: c.get('user')!.uid, ip: await clientIp(c, core) },
        c.req.valid('param').id,
        c.req.valid('json').action,
      ),
      200,
    ),
  )
  app.openapi(remove, async (c) =>
    c.json(
      await core.admin.deleteTexture(
        { uid: c.get('user')!.uid, ip: await clientIp(c, core) },
        c.req.valid('param').tid,
      ),
      200,
    ),
  )
  app.openapi(setRole, async (c) =>
    c.json(
      await core.admin.setRole(
        { uid: c.get('user')!.uid, ip: await clientIp(c, core) },
        c.req.valid('param').uid,
        c.req.valid('json').role,
      ),
      200,
    ),
  )
}
