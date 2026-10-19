import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { DomainError, type Core } from '@nextskin/domain'
import { MAX_PACKAGE_BYTES } from '@nextskin/plugin-host'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'

const errorContent = { description: '请求失败', content: { 'application/json': { schema: errorSchema } } }
const errors = {
  400: errorContent,
  409: errorContent,
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

const packageFile = z.instanceof(File).openapi({ type: 'string', format: 'binary' })
const manifest = z
  .record(z.string(), z.unknown())
  .openapi({ description: '插件包的 manifest.json（SDK 的 PluginManifest）' })
const preview = createRoute({
  method: 'post',
  path: '/admin/plugin-packages/preview',
  request: {
    body: { required: true, content: { 'multipart/form-data': { schema: z.object({ file: packageFile }) } } },
  },
  responses: {
    200: {
      description: '插件包校验通过，等管理员确认',
      content: {
        'application/json': {
          schema: z.object({
            packageHash: z.string(),
            manifest,
            messages: z.record(z.string(), z.record(z.string(), z.unknown())),
            highRisk: z.array(z.string()),
            action: z.enum(['install', 'upgrade']),
            previous: z
              .object({
                version: z.string(),
                enabled: z.boolean(),
                addedCapabilities: z.array(z.string()),
                addedNetwork: z.array(z.string()),
                addedHighRisk: z.array(z.string()),
                removedLogins: z.array(
                  z.object({ providerId: z.string(), label: z.string(), bindings: z.number().int() }),
                ),
              })
              .nullable(),
          }),
        },
      },
    },
    ...errors,
  },
})
type PreviewResponse = z.infer<(typeof preview.responses)[200]['content']['application/json']['schema']>
const install = createRoute({
  method: 'post',
  path: '/admin/plugin-packages',
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: z.object({ file: packageFile, packageHash: z.string().regex(/^[0-9a-f]{64}$/) }),
        },
      },
    },
  },
  responses: {
    201: {
      description: '已安装或升级',
      content: {
        'application/json': {
          schema: z.object({ id: z.string(), version: z.string(), action: z.enum(['install', 'upgrade']) }),
        },
      },
    },
    ...errors,
  },
})
const uninstall = createRoute({
  method: 'delete',
  path: '/admin/plugins/{id}',
  request: { params: z.object({ id: pluginId }) },
  responses: { ...ok, ...errors },
})
const restartHost = createRoute({
  method: 'post',
  path: '/admin/plugin-host/restart',
  responses: { ...ok, ...errors },
})

/** 插件包的上限（ADR-0033"安装"），multipart 的其余部分另外留 64 KiB */
export const MAX_PLUGIN_PACKAGE_REQUEST_BYTES = MAX_PACKAGE_BYTES + 64 * 1024

/** 后台的插件管理（ADR-0033）。会话由 `registerAdmin` 的 `/admin/*` 中间件检查 */
export function registerPluginAdmin(app: OpenAPIHono<AppEnv>, core: Core) {
  const actor = async (c: Parameters<Parameters<typeof app.openapi>[1]>[0]) => ({
    uid: c.get('user')!.uid,
    ip: await clientIp(c, core),
  })
  const bytes = async (file: File) => {
    if (file.size > MAX_PACKAGE_BYTES) throw new DomainError('plugin_package_invalid', { reason: 'too_large' })
    return new Uint8Array(await file.arrayBuffer())
  }
  app.openapi(preview, async (c) => {
    const result = await core.plugins.admin.preview(await actor(c), await bytes(c.req.valid('form').file))
    // manifest 是只读的 JSON；响应 schema 按普通对象描述它
    return c.json(result as unknown as PreviewResponse, 200)
  })
  app.openapi(install, async (c) => {
    const { file, packageHash } = c.req.valid('form')
    return c.json(await core.plugins.admin.install(await actor(c), await bytes(file), packageHash), 201)
  })
  app.openapi(uninstall, async (c) => {
    await core.plugins.admin.uninstall(await actor(c), c.req.valid('param').id)
    return c.json({ ok: true as const }, 200)
  })
  app.openapi(restartHost, async (c) => {
    await core.plugins.admin.restartHost(await actor(c))
    return c.json({ ok: true as const }, 200)
  })
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
