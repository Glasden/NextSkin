import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { AdminActor, Core } from '@nextskin/domain'
import type { Context } from 'hono'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'

/**
 * 后台对某个用户的账号操作（ADR-0036"接口"）。会话由 registerAdmin 挂在 /admin/* 上的 requireSession 检查；
 * 权限和"能对谁做"都在用例里按库里的身份检查，这里只校验格式。
 */
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
const MAX_ID = 2147483647
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(MAX_ID))
const target = z.object({ uid: id })
/** 插件 id、Provider id 的格式由 manifest 校验，这里只挡住明显不对的值，同用户侧的解绑 */
const bindingKey = z.string().min(1).max(255)
const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { 'application/json': { schema } } })
const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})
const userSchema = z.object({
  uid: z.number().int(),
  nickname: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  role: z.enum(['banned', 'user', 'admin', 'superadmin']),
  score: z.number().int(),
  registeredAt: z.iso.datetime(),
  avatar: z.object({ hash: z.string(), scale: z.number() }).nullable(),
})
const revokedSchema = z.object({ revokedSessions: z.number().int(), revokedTokens: z.number().int() })

const update = createRoute({
  method: 'patch',
  path: '/admin/users/{uid}',
  request: {
    params: target,
    body: jsonBody(
      z
        .object({
          role: z.enum(['banned', 'user', 'admin']).optional(),
          nickname: z.string().optional(),
          emailVerified: z.boolean().optional(),
          /** emailVerified 为 true 时必填：页面上显示、管理员核实过的地址 */
          expectedEmail: z.string().optional(),
        })
        .refine((body) => body.role !== undefined || body.nickname !== undefined || body.emailVerified !== undefined)
        .refine((body) => body.emailVerified !== true || body.expectedEmail !== undefined, {
          path: ['expectedEmail'],
        }),
    ),
  },
  responses: { 200: jsonResponse(userSchema, '用户已更新'), ...errors },
})
const email = createRoute({
  method: 'post',
  path: '/admin/users/{uid}/email',
  request: {
    params: target,
    body: jsonBody(z.object({ email: z.string(), verified: z.boolean().optional() })),
  },
  responses: {
    200: jsonResponse(
      z.discriminatedUnion('status', [
        z.object({ status: z.literal('pending'), pendingEmail: z.string() }),
        z.object({ status: z.literal('changed'), user: userSchema }),
      ]),
      '配置了邮件时已向新地址发出确认链接（pending），否则已立即生效（changed）',
    ),
    ...errors,
  },
})
const password = createRoute({
  method: 'post',
  path: '/admin/users/{uid}/password',
  request: {
    params: target,
    body: jsonBody(
      z.object({
        password: z.string(),
        /** 收回账号：删掉全部通行密钥、解绑全部第三方账号 */
        removeOtherMethods: z.boolean().optional(),
        /** 收回账号：邮箱立即换成这个地址，算已验证 */
        newEmail: z.string().optional(),
      }),
    ),
  },
  responses: { 200: jsonResponse(revokedSchema, '密码已设置，在途的登录已作废'), ...errors },
})
const twoFactor = createRoute({
  method: 'delete',
  path: '/admin/users/{uid}/two-factor',
  request: { params: target },
  responses: { 200: jsonResponse(userSchema, '两步验证已关闭'), ...errors },
})
const passkeys = createRoute({
  method: 'delete',
  path: '/admin/users/{uid}/passkeys',
  request: { params: target },
  responses: {
    200: jsonResponse(revokedSchema.extend({ deleted: z.number().int() }), '通行密钥已全部删除，在途的登录已作废'),
    ...errors,
  },
})
const binding = createRoute({
  method: 'delete',
  path: '/admin/users/{uid}/bindings/{pluginId}/{providerId}',
  request: { params: target.extend({ pluginId: bindingKey, providerId: bindingKey }) },
  responses: { 200: jsonResponse(revokedSchema, '已解绑，在途的登录已作废'), ...errors },
})
const sessions = createRoute({
  method: 'delete',
  path: '/admin/users/{uid}/sessions',
  request: { params: target },
  responses: { 200: jsonResponse(revokedSchema, '网页和启动器的登录已全部作废'), ...errors },
})
const score = createRoute({
  method: 'post',
  path: '/admin/users/{uid}/score',
  request: {
    params: target,
    body: jsonBody(
      z.object({
        // 只按增量改（ADR-0036"改积分"）：0 和小数在这里拒绝，否则 adjustScore 抛的 RangeError 会变成 500
        delta: z
          .number()
          .int()
          .min(-MAX_ID)
          .max(MAX_ID)
          .refine((value) => value !== 0),
        // 和用例一样去掉首尾空白之后按码点数，"字符"在整个仓库里都是码点
        note: z
          .string()
          .refine((value) => [...value.trim()].length <= 200)
          .openapi({ maxLength: 200 })
          .optional(),
      }),
    ),
  },
  responses: { 200: jsonResponse(z.object({ score: z.number().int() }), '积分已调整，返回调整后的余额'), ...errors },
})
const remove = createRoute({
  method: 'delete',
  path: '/admin/users/{uid}',
  request: {
    params: target,
    // 公开材质默认留下（ADR-0025）；delete 表示逐个删掉，还要有 textures.manage
    query: z.object({ publicTextures: z.enum(['keep', 'delete']).optional() }),
  },
  responses: { 200: jsonResponse(z.object({}), '用户已删除'), ...errors },
})

export function registerAdminUsers(app: OpenAPIHono<AppEnv>, core: Core) {
  const actor = async (c: Context<AppEnv>): Promise<AdminActor> => ({
    uid: c.get('user')!.uid,
    ip: await clientIp(c, core),
  })
  app.openapi(update, async (c) =>
    c.json(await core.admin.updateUser(await actor(c), c.req.valid('param').uid, c.req.valid('json')), 200),
  )
  app.openapi(email, async (c) =>
    c.json(
      await core.admin.changeUserEmail(
        await actor(c),
        c.req.valid('param').uid,
        c.req.valid('json'),
        c.get('requestRoot'),
      ),
      200,
    ),
  )
  app.openapi(password, async (c) =>
    c.json(await core.admin.setUserPassword(await actor(c), c.req.valid('param').uid, c.req.valid('json')), 200),
  )
  app.openapi(twoFactor, async (c) =>
    c.json(await core.admin.disableUserTwoFactor(await actor(c), c.req.valid('param').uid), 200),
  )
  app.openapi(passkeys, async (c) =>
    c.json(await core.admin.deleteUserPasskeys(await actor(c), c.req.valid('param').uid), 200),
  )
  app.openapi(binding, async (c) => {
    const { uid, pluginId, providerId } = c.req.valid('param')
    return c.json(await core.admin.unlinkUserAccount(await actor(c), uid, pluginId, providerId), 200)
  })
  app.openapi(sessions, async (c) =>
    c.json(await core.admin.revokeUserSessions(await actor(c), c.req.valid('param').uid), 200),
  )
  app.openapi(score, async (c) =>
    c.json(await core.admin.adjustUserScore(await actor(c), c.req.valid('param').uid, c.req.valid('json')), 200),
  )
  app.openapi(remove, async (c) => {
    await core.admin.deleteUser(await actor(c), c.req.valid('param').uid, {
      publicTextures: c.req.valid('query').publicTextures ?? 'keep',
    })
    return c.json({}, 200)
  })
}
