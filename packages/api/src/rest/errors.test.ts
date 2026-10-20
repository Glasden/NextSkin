import { OpenAPIHono } from '@hono/zod-openapi'
import { DomainError, type Core } from '@nextskin/domain'
import { expect, test } from 'vitest'
import type { AppEnv } from '../env.ts'
import { createErrorResponse, restErrorCode } from './errors.ts'

const errors = [
  ['oauth_client_not_found', 404, {}],
  ['oauth_client_name_invalid', 400, { min: 1, max: 255 }],
  ['oauth_redirect_uri_invalid', 400, { uri: 'http://example.test/cb', type: 'web' }],
  ['oauth_redirect_uri_required', 400, {}],
  ['oauth_redirect_uris_too_many', 400, { max: 20 }],
  ['oauth_redirect_uri_too_long', 400, { max: 2048 }],
  ['oauth_client_public', 400, {}],
  ['oauth_client_shared', 403, {}],
  ['oauth_client_not_manageable', 403, {}],
] as const

test.each(errors)('%s 有状态码和两种语言的可插值文案', async (code, status, params) => {
  const core = { settings: { read: () => Promise.resolve({ 'site.locale': 'zh-CN' }) } } as unknown as Core
  const app = new OpenAPIHono<AppEnv>()
  const respond = createErrorResponse(core)
  app.get('/', (c) => respond(c, code, params))
  expect(restErrorCode(new DomainError(code, params))).toBe(code)
  for (const locale of ['zh-CN', 'en']) {
    const response = await app.request('http://example.test/', { headers: { 'accept-language': locale } })
    expect(response.status).toBe(status)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe(code)
    expect(body.error.message).not.toBe(`errors.${code}`)
    expect(body.error.message).not.toMatch(/\{(?:min|max|uri|type)\}/)
  }
})
