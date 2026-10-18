import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { Core } from '@nextskin/domain'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'

const errorContent = { description: '请求失败', content: { 'application/json': { schema: errorSchema } } }
const errors = {
  400: errorContent,
  401: errorContent,
  403: errorContent,
  404: errorContent,
  413: errorContent,
  415: errorContent,
  500: errorContent,
  502: errorContent,
  503: errorContent,
  504: errorContent,
}
const pluginId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
const jobId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
const ok = {
  200: { description: '完成', content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } } },
}

const enable = createRoute({
  method: 'post',
  path: '/admin/plugins/{id}/enable',
  request: { params: z.object({ id: pluginId }) },
  responses: { ...ok, ...errors },
})
const disable = createRoute({
  method: 'post',
  path: '/admin/plugins/{id}/disable',
  request: { params: z.object({ id: pluginId }) },
  responses: { ...ok, ...errors },
})
const updateSettings = createRoute({
  method: 'patch',
  path: '/admin/plugins/{id}/settings',
  request: {
    params: z.object({ id: pluginId }),
    body: {
      required: true,
      content: { 'application/json': { schema: z.object({ values: z.record(z.string(), z.unknown()) }) } },
    },
  },
  responses: {
    200: {
      description: '设置已更新',
      content: { 'application/json': { schema: z.object({ updated: z.array(z.string()) }) } },
    },
    ...errors,
  },
})
const retryDeadLetter = createRoute({
  method: 'post',
  path: '/admin/plugins/{id}/dead-letters/{job}/retry',
  request: { params: z.object({ id: pluginId, job: jobId }) },
  responses: { ...ok, ...errors },
})
const deleteDeadLetter = createRoute({
  method: 'delete',
  path: '/admin/plugins/{id}/dead-letters/{job}',
  request: { params: z.object({ id: pluginId, job: jobId }) },
  responses: { ...ok, ...errors },
})

/** 后台的插件管理（ADR-0033）。会话由 `registerAdmin` 的 `/admin/*` 中间件检查 */
export function registerPluginAdmin(app: OpenAPIHono<AppEnv>, core: Core) {
  app.openapi(enable, async (c) => {
    await core.plugins.admin.enable({ uid: c.get('user')!.uid, ip: await clientIp(c, core) }, c.req.valid('param').id)
    return c.json({ ok: true as const }, 200)
  })
  app.openapi(disable, async (c) => {
    await core.plugins.admin.disable({ uid: c.get('user')!.uid, ip: await clientIp(c, core) }, c.req.valid('param').id)
    return c.json({ ok: true as const }, 200)
  })
  app.openapi(updateSettings, async (c) =>
    c.json(
      await core.plugins.admin.updateSettings(
        { uid: c.get('user')!.uid, ip: await clientIp(c, core) },
        c.req.valid('param').id,
        c.req.valid('json').values,
      ),
      200,
    ),
  )
  app.openapi(retryDeadLetter, async (c) => {
    const { id, job } = c.req.valid('param')
    await core.plugins.admin.retryDeadLetter({ uid: c.get('user')!.uid, ip: await clientIp(c, core) }, id, job)
    return c.json({ ok: true as const }, 200)
  })
  app.openapi(deleteDeadLetter, async (c) => {
    const { id, job } = c.req.valid('param')
    await core.plugins.admin.deleteDeadLetter({ uid: c.get('user')!.uid, ip: await clientIp(c, core) }, id, job)
    return c.json({ ok: true as const }, 200)
  })
}
