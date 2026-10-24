import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { managerParams, updateManagerSchema, type Core } from '@nextskin/domain'
import type { Context } from 'hono'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'

const release = z.object({
  version: z.string(),
  date: z.iso.datetime(),
  notes: z.url(),
  minNode: z.number().int().positive(),
  managerProtocol: z.int().positive(),
})
const status = z.object({
  manager: updateManagerSchema,
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
  latest: release.nullable(),
  target: release.nullable(),
})
const errorContent = { description: '请求失败', content: { 'application/json': { schema: errorSchema } } }
const responses = {
  200: { description: '更新检测状态', content: { 'application/json': { schema: status } } },
  400: errorContent,
  401: errorContent,
  403: errorContent,
  409: errorContent,
  500: errorContent,
  503: errorContent,
}
const get = createRoute({ method: 'get', path: '/admin/updates', responses })
const check = createRoute({ method: 'post', path: '/admin/updates/check', responses })

const accepted = z.object({ accepted: z.literal(true) })
const prepare = createRoute({
  method: 'post',
  path: '/admin/updates/prepare',
  request: { body: { required: true, content: { 'application/json': { schema: managerParams.prepare } } } },
  responses: {
    ...responses,
    200: { description: '已接受准备请求', content: { 'application/json': { schema: accepted } } },
  },
})
const apply = createRoute({
  method: 'post',
  path: '/admin/updates/apply',
  request: { body: { required: true, content: { 'application/json': { schema: managerParams.apply } } } },
  responses: {
    ...responses,
    200: { description: '已接受升级请求', content: { 'application/json': { schema: accepted } } },
  },
})
const rollback = createRoute({
  method: 'post',
  path: '/admin/updates/rollback',
  request: { body: { required: true, content: { 'application/json': { schema: managerParams.rollback } } } },
  responses: {
    ...responses,
    200: { description: '已接受回滚请求', content: { 'application/json': { schema: accepted } } },
  },
})
const cancel = createRoute({
  method: 'post',
  path: '/admin/updates/cancel',
  responses: {
    ...responses,
    200: {
      description: '取消准备结果',
      content: { 'application/json': { schema: z.object({ cancelled: z.boolean() }) } },
    },
  },
})

/** 会话由 registerAdmin 验证，领域层按数据库里的身份检查超级管理员权限。 */
export function registerAdminUpdates(app: OpenAPIHono<AppEnv>, core: Core) {
  const actor = async (c: Context<AppEnv>) => ({ uid: c.get('user')!.uid, ip: await clientIp(c, core) })
  app.openapi(prepare, async (c) =>
    c.json(await core.updates.prepare(await actor(c), c.req.valid('json').version), 200),
  )
  app.openapi(apply, async (c) => {
    const { version, backupConfirmed } = c.req.valid('json')
    return c.json(await core.updates.apply(await actor(c), version, { backupConfirmed }), 200)
  })
  app.openapi(rollback, async (c) => c.json(await core.updates.rollback(await actor(c), c.req.valid('json')), 200))
  app.openapi(cancel, async (c) => c.json(await core.updates.cancel(await actor(c)), 200))
  app.openapi(get, async (c) =>
    c.json(await core.updates.status({ uid: c.get('user')!.uid, ip: await clientIp(c, core) }), 200),
  )
  app.openapi(check, async (c) =>
    c.json(await core.updates.check({ uid: c.get('user')!.uid, ip: await clientIp(c, core) }), 200),
  )
}
