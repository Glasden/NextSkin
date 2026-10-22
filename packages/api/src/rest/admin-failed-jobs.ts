import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { AdminActor, Core } from '@nextskin/domain'
import type { Context } from 'hono'
import { clientIp } from '../client-ip.ts'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'

// 后台的失败任务页（ADR-0051）。会话由 registerAdmin 挂在 /admin/* 上；权限由领域层检查。
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
// failed_jobs.id 是 integer，在 MySQL 和 PostgreSQL 上是 32 位：更大的数传进查询会报错
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(2147483647))
const path = '/admin/failed-jobs'
const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})
const failedJob = z.object({
  id: z.number().int(),
  name: z.string(),
  payload: z.unknown().openapi({ description: '进死信时存下的载荷，邮件的去掉了链接' }),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  failedAt: z.string(),
  retryable: z.boolean(),
  user: z.object({ uid: z.number().int(), nickname: z.string() }).nullable(),
})
const list = createRoute({
  method: 'get',
  path,
  request: { query: z.object({ page: id.optional().default(1) }) },
  responses: {
    200: jsonResponse(
      z.object({ total: z.number().int(), latestId: z.number().int().nullable(), items: z.array(failedJob) }),
      '核心任务的死信，最新的在前',
    ),
    ...errors,
  },
})
const retry = createRoute({
  method: 'post',
  path: `${path}/{id}/retry`,
  request: { params: z.object({ id }) },
  responses: { 200: jsonResponse(z.object({ ok: z.literal(true) }), '已放回队列'), ...errors },
})
const remove = createRoute({
  method: 'delete',
  path: `${path}/{id}`,
  request: { params: z.object({ id }) },
  responses: { 200: jsonResponse(z.object({ ok: z.literal(true) }), '已删除'), ...errors },
})
// 全部重试、全部删除只处理编号不大于 through 的：页面打开之后才失败的任务管理员还没看过
const retryAll = createRoute({
  method: 'post',
  path: `${path}/retry`,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ through: z.number().int().positive().max(2147483647) }),
        },
      },
    },
  },
  responses: {
    200: jsonResponse(z.object({ retried: z.number().int(), skipped: z.number().int() }), '能重试的都已放回队列'),
    ...errors,
  },
})
const removeAll = createRoute({
  method: 'delete',
  path,
  request: { query: z.object({ through: id }) },
  responses: { 200: jsonResponse(z.object({ deleted: z.number().int() }), '已删除'), ...errors },
})

export function registerAdminFailedJobs(app: OpenAPIHono<AppEnv>, core: Core) {
  const actor = async (c: Context<AppEnv>): Promise<AdminActor> => ({
    uid: c.get('user')!.uid,
    ip: await clientIp(c, core),
  })
  app.openapi(list, async (c) => c.json(await core.admin.listFailedJobs(c.get('user')!.uid, c.req.valid('query')), 200))
  app.openapi(retryAll, async (c) =>
    c.json(await core.admin.retryAllFailedJobs(await actor(c), c.req.valid('json').through), 200),
  )
  app.openapi(removeAll, async (c) =>
    c.json(await core.admin.deleteAllFailedJobs(await actor(c), c.req.valid('query').through), 200),
  )
  app.openapi(retry, async (c) => {
    await core.admin.retryFailedJob(await actor(c), c.req.valid('param').id)
    return c.json({ ok: true as const }, 200)
  })
  app.openapi(remove, async (c) => {
    await core.admin.deleteFailedJob(await actor(c), c.req.valid('param').id)
    return c.json({ ok: true as const }, 200)
  })
}
