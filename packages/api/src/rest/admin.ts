import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { CAPTCHA_HEADER, DomainError, SITE_IMAGE_MAX_BYTES, type Core } from '@nextskin/domain'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { registerAdminTextures } from './admin-textures.ts'
import { registerAdminCloset } from './admin-closet.ts'
import { registerAdminFailedJobs } from './admin-failed-jobs.ts'
import { registerAdminOAuthClients } from './admin-oauth-clients.ts'
import { registerAdminPlayers } from './admin-players.ts'
import { registerAdminUsers } from './admin-users.ts'
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
  502: errorContent,
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
const updatedSchema = z.object({ updated: z.array(z.string()) })
const updateSettings = createRoute({
  method: 'patch',
  path: '/admin/settings',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: z.object({ values: z.record(z.string(), z.unknown()) }) } },
    },
  },
  responses: {
    200: { description: '设置已更新', content: { 'application/json': { schema: updatedSchema } } },
    ...errors,
  },
})
const generateSetting = createRoute({
  method: 'post',
  path: '/admin/settings/{key}/generate',
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: { description: '设置已生成', content: { 'application/json': { schema: updatedSchema } } },
    ...errors,
  },
})
const uploadSiteImage = createRoute({
  method: 'post',
  path: '/admin/site-images',
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: z.object({ file: z.instanceof(File).openapi({ type: 'string', format: 'binary' }) }),
        },
      },
    },
  },
  responses: {
    201: {
      description: '站点图片已上传；值是像素 hash，随设置表单保存才生效（ADR-0042）',
      content: { 'application/json': { schema: z.object({ hash: z.string() }) } },
    },
    ...errors,
  },
})
const testMail = createRoute({
  method: 'post',
  path: '/admin/settings/mail/test',
  responses: {
    200: { description: '测试邮件已发送', content: { 'application/json': { schema: z.object({ to: z.string() }) } } },
    ...errors,
  },
})
const testCaptcha = createRoute({
  method: 'post',
  path: '/admin/settings/captcha/test',
  request: { headers: z.object({ [CAPTCHA_HEADER]: z.string().optional() }) },
  responses: {
    200: {
      description: '验证码核对结果',
      content: {
        'application/json': {
          schema: z.object({ result: z.enum(['passed', 'failed', 'unavailable']), errorCodes: z.array(z.string()) }),
        },
      },
    },
    ...errors,
  },
})
export function registerAdmin(app: OpenAPIHono<AppEnv>, core: Core) {
  app.use('/admin/*', requireSession(core))
  app.openapi(updateSettings, async (c) =>
    c.json(
      await core.admin.updateSettings(
        { uid: c.get('user')!.uid, ip: await clientIp(c, core) },
        c.req.valid('json').values,
      ),
      200,
    ),
  )
  app.openapi(generateSetting, async (c) =>
    c.json(
      await core.admin.generateSetting(
        { uid: c.get('user')!.uid, ip: await clientIp(c, core) },
        c.req.valid('param').key,
      ),
      200,
    ),
  )
  app.openapi(testCaptcha, async (c) => {
    const ip = await clientIp(c, core)
    return c.json(
      await core.admin.testCaptcha(
        { uid: c.get('user')!.uid, ip },
        { token: c.req.header(CAPTCHA_HEADER) ?? null, ip },
      ),
      200,
    )
  })
  app.openapi(uploadSiteImage, async (c) => {
    const { file } = c.req.valid('form')
    if (file.size > SITE_IMAGE_MAX_BYTES) throw new DomainError('site_image_file_invalid')
    const actor = { uid: c.get('user')!.uid, ip: await clientIp(c, core) }
    return c.json(await core.admin.uploadSiteImage(actor, new Uint8Array(await file.arrayBuffer())), 201)
  })
  app.openapi(testMail, async (c) =>
    c.json(await core.admin.sendTestMail({ uid: c.get('user')!.uid, ip: await clientIp(c, core) }), 200),
  )
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
  // 用户的账号操作，包括改身份的 PATCH（ADR-0036）
  registerAdminUsers(app, core)
  // 角色管理，以及转让、换材质时按输入查用户和材质的两个读接口（ADR-0036）
  registerAdminPlayers(app, core)
  registerAdminOAuthClients(app, core)
  registerAdminTextures(app, core)
  registerAdminCloset(app, core)
  // 核心任务的死信（ADR-0051）
  registerAdminFailedJobs(app, core)
}
