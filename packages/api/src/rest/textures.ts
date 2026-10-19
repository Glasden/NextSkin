import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { DomainError, type Core } from '@nextskin/domain'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'
import type { RateLimiter } from './rate-limit.ts'
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
  429: errorContent,
  500: errorContent,
  503: errorContent,
}
const type = z.enum(['steve', 'alex', 'cape'])
export const texture = z.object({
  tid: z.number().int(),
  name: z.string(),
  type,
  hash: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  sizeBytes: z.number().int(),
  uploader: z.number().int().nullable(),
  public: z.boolean(),
  description: z.string().nullable(),
  likes: z.number().int(),
  uploadedAt: z.iso.datetime(),
})
const params = z.object({
  tid: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
})
const upload = createRoute({
  method: 'post',
  path: '/textures',
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.instanceof(File).openapi({ type: 'string', format: 'binary' }),
            name: z.string(),
            type,
            public: z.enum(['true', 'false']),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: '材质已上传',
      content: { 'application/json': { schema: z.object({ texture, charged: z.number().int() }) } },
    },
    ...errors,
  },
})
const update = createRoute({
  method: 'patch',
  path: '/textures/{tid}',
  request: {
    params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().optional(),
            type: type.optional(),
            public: z.boolean().optional(),
            description: z.string().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: '材质已更新',
      content: { 'application/json': { schema: z.object({ texture, scoreDelta: z.number().int() }) } },
    },
    ...errors,
  },
})
const remove = createRoute({
  method: 'delete',
  path: '/textures/{tid}',
  request: { params },
  responses: {
    200: {
      description: '材质已删除',
      content: { 'application/json': { schema: z.object({ refunded: z.number().int() }) } },
    },
    ...errors,
  },
})

export function registerTextures(app: OpenAPIHono<AppEnv>, core: Core, limiter: RateLimiter) {
  const session = requireSession(core)
  app.post('/textures', session, async (c, next) => {
    const limit = await limiter.consume(`texture-upload:${c.get('user')!.uid}`)
    if (!limit.allowed) throw new DomainError('too_many_requests', { retryAfter: limit.retryAfter })
    await next()
  })
  app.patch('/textures/:tid', session)
  app.delete('/textures/:tid', session)
  app.openapi(upload, async (c) => {
    const { file, public: visibility, ...fields } = c.req.valid('form')
    const max = c.get('textureMaxKb')!
    if (file.size > max * 1024) throw new DomainError('texture_file_too_large', { max })
    return c.json(
      await core.textures.upload(
        { uid: c.get('user')!.uid },
        { ...fields, public: visibility === 'true', bytes: new Uint8Array(await file.arrayBuffer()) },
      ),
      201,
    )
  })
  app.openapi(update, async (c) =>
    c.json(await core.textures.update({ uid: c.get('user')!.uid }, c.req.valid('param').tid, c.req.valid('json')), 200),
  )
  app.openapi(remove, async (c) =>
    c.json(await core.textures.delete({ uid: c.get('user')!.uid }, c.req.valid('param').tid), 200),
  )
}
