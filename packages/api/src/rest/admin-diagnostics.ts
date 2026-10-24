import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { Core } from '@nextskin/domain'
import { LOG_LEVELS } from '@nextskin/logging'
import type { Context } from 'hono'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'

const logRecord = z
  .object({
    time: z.string(),
    level: z.enum(LOG_LEVELS),
    source: z.string(),
    msg: z.string(),
    area: z.string().optional(),
    plugin: z.string().optional(),
    raw: z.boolean().optional(),
  })
  .catchall(z.unknown())
const page = z.object({
  available: z.boolean(),
  entries: z.array(z.object({ id: z.string(), line: z.string(), record: logRecord.nullable() })),
  next: z.string().nullable(),
  scanLimited: z.boolean(),
})
const error = { description: '请求失败', content: { 'application/json': { schema: errorSchema } } }
const errors = { 400: error, 401: error, 403: error, 500: error }
const logs = createRoute({
  method: 'get',
  path: '/admin/diagnostics/logs',
  request: {
    query: z.object({
      level: z.enum(LOG_LEVELS).optional(),
      source: z.string().max(256).optional(),
      q: z.string().max(1024).optional(),
      cursor: z.string().max(40_000).optional(),
    }),
  },
  responses: {
    200: { description: '从新到旧的一页日志', content: { 'application/json': { schema: page } } },
    ...errors,
  },
})
const bundle = createRoute({
  method: 'post',
  path: '/admin/diagnostics/export',
  responses: {
    200: {
      description: '脱敏诊断包',
      content: { 'application/zip': { schema: z.string().openapi({ format: 'binary' }) } },
      headers: {
        'Content-Disposition': { schema: { type: 'string' } },
        'Cache-Control': { schema: { type: 'string' } },
      },
    },
    ...errors,
  },
})

/** 会话和同源检查由 REST 入口处理；具名权限由领域层按数据库身份判断。 */
export function registerAdminDiagnostics(app: OpenAPIHono<AppEnv>, core: Core) {
  const actor = async (c: Context<AppEnv>) => ({ uid: c.get('user')!.uid, ip: await clientIp(c, core) })
  app.openapi(logs, async (c) => {
    const { q, ...query } = c.req.valid('query')
    const result = await core.diagnostics.logs(await actor(c), { ...query, ...(q === undefined ? {} : { text: q }) })
    c.header('Cache-Control', 'no-store')
    return c.json(result, 200)
  })
  app.openapi(bundle, async (c) => {
    const result = await core.diagnostics.export(await actor(c))
    return new Response(result.body as Uint8Array<ArrayBuffer>, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  })
}
