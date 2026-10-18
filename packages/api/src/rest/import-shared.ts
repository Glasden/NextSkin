import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import type { AppEnv } from '../env.ts'
import { errorSchema } from './errors.ts'

export const sourceSchema = z.object({
  connection: z.discriminatedUnion('dialect', [
    z.object({ dialect: z.literal('sqlite'), file: z.string().min(1).max(1024) }),
    z.object({
      dialect: z.enum(['mysql', 'postgres']),
      host: z.string().min(1).max(255),
      port: z.number().int().min(1).max(65535),
      database: z.string().min(1).max(255),
      username: z.string().max(255),
      password: z.string().max(1024),
    }),
  ]),
  prefix: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_]*$/),
  texturesDirectory: z.string().min(1).max(1024),
  timeZone: z.string().min(1).max(64),
  passwordMethod: z.string().min(1).max(32).nullable(),
  salt: z.string().max(1024),
})
export const startSchema = sourceSchema.extend({
  dryRun: z.boolean(),
  siteUrl: z.string().max(2048).nullable(),
  uuidOverrides: z
    .record(z.string().regex(/^\d{1,10}$/), z.string().min(1).max(64))
    .refine((values) => Object.keys(values).length <= 10000),
  replace: z.boolean(),
  force: z.boolean(),
})
export const envSchema = z.object({ text: z.string().max(16384), directory: z.string().max(1024).nullable() })
export const idSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(2147483647))
export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
})
export const jsonResult = { description: '请求成功', content: { 'application/json': { schema: z.unknown() } } }
const errorContent = { description: '请求失败', content: { 'application/json': { schema: errorSchema } } }
export const importErrors = {
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
export const markdownResult = { description: '对账报告', content: { 'text/markdown': { schema: z.string() } } }
export function setImportCookie(
  c: Context<AppEnv>,
  name: 'nextskin-setup' | 'nextskin-import-run',
  token: string,
  maxAge = 86400,
) {
  setCookie(c, name, token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge,
    secure: c.get('requestRoot').startsWith('https:'),
  })
}
export function markdownResponse(c: Context<AppEnv>, markdown: string, id: number | null) {
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="import-${id ?? 'run'}.md"`)
  return c.body(markdown, 200)
}
