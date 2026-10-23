import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { Core } from '@nextskin/domain'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'

const status = z.object({
  enabled: z.boolean(),
  current: z.string().nullable(),
  deployment: z.enum(['bundle', 'docker', 'source']),
  checkedAt: z.iso.datetime().nullable(),
  failure: z
    .discriminatedUnion('code', [
      z.object({ at: z.iso.datetime(), code: z.literal('http'), status: z.number().int().min(100).max(599) }),
      z.object({ at: z.iso.datetime(), code: z.enum(['network', 'invalid', 'too_large']) }),
    ])
    .nullable(),
  latest: z
    .object({ version: z.string(), date: z.iso.datetime(), notes: z.url(), minNode: z.number().int().positive() })
    .nullable(),
})
const errorContent = { description: '请求失败', content: { 'application/json': { schema: errorSchema } } }
const responses = {
  200: { description: '更新检测状态', content: { 'application/json': { schema: status } } },
  401: errorContent,
  403: errorContent,
  409: errorContent,
  500: errorContent,
}
const get = createRoute({ method: 'get', path: '/admin/updates', responses })
const check = createRoute({ method: 'post', path: '/admin/updates/check', responses })

/** 会话由 registerAdmin 验证，领域层按数据库里的身份检查超级管理员权限。 */
export function registerAdminUpdates(app: OpenAPIHono<AppEnv>, core: Core) {
  app.openapi(get, async (c) =>
    c.json(await core.updates.status({ uid: c.get('user')!.uid, ip: await clientIp(c, core) }), 200),
  )
  app.openapi(check, async (c) =>
    c.json(await core.updates.check({ uid: c.get('user')!.uid, ip: await clientIp(c, core) }), 200),
  )
}
