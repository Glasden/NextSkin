import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { DomainError, type Core } from '@nextskin/domain'
import { getCookie } from 'hono/cookie'
import type { AppEnv } from '../env.ts'
import type { ImportGateway } from '../import-gateway.ts'
import {
  envSchema,
  idSchema,
  importErrors,
  jsonBody,
  jsonResult,
  markdownResponse,
  markdownResult,
  setImportCookie,
  sourceSchema,
  startSchema,
} from './import-shared.ts'

export function registerImport(app: OpenAPIHono<AppEnv>, core: Core, importer: ImportGateway) {
  // 在 registerAdmin 的会话中间件之后、请求校验之前，领域层按数据库里的角色核对权限。
  app.use('/admin/import/*', async (c, next) => {
    await core.admin.requirePermission(c.get('user')!.uid, 'import.manage')
    await next()
  })
  app.openapi(
    createRoute({
      method: 'post',
      path: '/admin/import/env',
      request: { body: jsonBody(envSchema) },
      responses: { 200: jsonResult, ...importErrors },
    }),
    (c) => {
      const { text, directory } = c.req.valid('json')
      return c.json(importer.parseEnv(text, directory), 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/admin/import/check',
      request: { body: jsonBody(sourceSchema) },
      responses: { 200: jsonResult, ...importErrors },
    }),
    async (c) => c.json(await importer.check(c.req.valid('json')), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/admin/import/runs',
      request: { body: jsonBody(startSchema) },
      responses: { 202: jsonResult, ...importErrors },
    }),
    async (c) => {
      const { token, state } = await importer.start(c.req.valid('json'), {
        entry: 'admin',
        startedBy: c.get('user')!.email,
      })
      setImportCookie(c, 'nextskin-import-run', token)
      return c.json({ run: state }, 202)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/admin/import/runs',
      request: {
        query: z.object({
          page: z
            .string()
            .regex(/^[1-9]\d*$/)
            .transform(Number)
            .pipe(z.number().int().max(100000000))
            .default(1),
        }),
      },
      responses: { 200: jsonResult, ...importErrors },
    }),
    async (c) => c.json(await importer.listRuns(c.req.valid('query').page, 20), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/admin/import/runs/{id}',
      request: { params: z.object({ id: idSchema }) },
      responses: { 200: jsonResult, ...importErrors },
    }),
    async (c) => {
      const result = await importer.getRun(c.req.valid('param').id)
      if (!result) throw new DomainError('import_run_not_found')
      return c.json(result, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/admin/import/runs/{id}/report.md',
      request: { params: z.object({ id: idSchema }) },
      responses: { 200: markdownResult, ...importErrors },
    }),
    async (c) => {
      const id = c.req.valid('param').id
      const markdown = await importer.runMarkdownById(id)
      if (markdown === null) throw new DomainError('import_run_not_found')
      return markdownResponse(c, markdown, id)
    },
  )
  app.openapi(
    createRoute({ method: 'get', path: '/import/run', responses: { 200: jsonResult, ...importErrors } }),
    (c) => {
      const state = importer.run(getCookie(c, 'nextskin-import-run') ?? '')
      if (!state) throw new DomainError('import_run_not_found')
      return c.json(state, 200)
    },
  )
  app.openapi(
    createRoute({ method: 'post', path: '/import/run/cancel', responses: { 200: jsonResult, ...importErrors } }),
    (c) => {
      const state = importer.cancel(getCookie(c, 'nextskin-import-run') ?? '')
      if (!state) throw new DomainError('import_run_not_found')
      return c.json(state, 200)
    },
  )
  app.openapi(
    createRoute({ method: 'get', path: '/import/run/report.md', responses: { 200: markdownResult, ...importErrors } }),
    (c) => {
      const token = getCookie(c, 'nextskin-import-run') ?? ''
      const markdown = importer.runMarkdown(token)
      if (markdown === null) throw new DomainError('import_run_not_found')
      return markdownResponse(c, markdown, importer.run(token)?.id ?? null)
    },
  )
}
