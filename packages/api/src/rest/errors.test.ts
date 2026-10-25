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

test('action_denied 返回 403 和插件的文案、plugin、reason', async () => {
  const core = { settings: { read: () => Promise.resolve({ 'site.locale': 'zh-CN' }) } } as unknown as Core
  const app = new OpenAPIHono<AppEnv>()
  const respond = createErrorResponse(core)
  const error = new DomainError('action_denied', { plugin: 'binding', reason: 'binding_required', message: '请先绑定' })
  app.get('/', (c) => respond(c, restErrorCode(error), error.params))
  for (const locale of ['zh-CN', 'en']) {
    const response = await app.request('http://example.test/', { headers: { 'accept-language': locale } })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: { code: 'action_denied', message: '请先绑定', plugin: 'binding', reason: 'binding_required' },
    })
  }
})

test.each<Record<string, string | number>>([
  { reason: 'text', line: 3 },
  { reason: 'tag', line: 3, tag: 'style' },
  { reason: 'attribute', line: 3, tag: 'meta', attribute: 'http-equiv' },
  { reason: 'event_handler', line: 3, tag: 'script', attribute: 'onload' },
  { reason: 'script_src', line: 3, tag: 'script', attribute: 'src' },
  { reason: 'script_src_and_code', line: 3, tag: 'script' },
  { reason: 'script_type', line: 3, tag: 'script', attribute: 'type', value: 'importmap' },
  { reason: 'meta', line: 3, tag: 'meta' },
  { reason: 'meta_reserved', line: 3, tag: 'meta', attribute: 'name', value: 'viewport' },
])('后台页头校验错误显示具体原因、行号和字段：$reason', async (params) => {
  const core = { settings: { read: () => Promise.resolve({ 'site.locale': 'zh-CN' }) } } as unknown as Core
  const app = new OpenAPIHono<AppEnv>()
  const respond = createErrorResponse(core)
  app.get('/api/admin/settings', (c) => respond(c, 'custom_head_invalid', params, ['custom.head']))
  expect(restErrorCode(new DomainError('custom_head_invalid', params))).toBe('custom_head_invalid')
  for (const locale of ['zh-CN', 'en']) {
    const response = await app.request('http://example.test/api/admin/settings', {
      headers: { 'accept-language': locale },
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { code: string; message: string; fields: Record<string, { code: string; message: string }> }
    }
    expect(body.error.code).toBe('custom_head_invalid')
    expect(body.error.message).toContain(locale === 'zh-CN' ? '第 3 行：' : 'Line 3:')
    expect(body.error.message).not.toMatch(/errors\.|\{(?:tag|attribute|value|line)\}/)
    if (params.tag) expect(body.error.message).toContain(`<${params.tag}>`)
    if (params.attribute === 'onload') expect(body.error.message).toContain('onload')
    if (params.value) expect(body.error.message).toContain(params.value)
    expect(body.error.fields['custom.head']).toEqual({ code: body.error.code, message: body.error.message })
  }
})

test('后台 CSS 校验错误返回 400，自动绑定字段并显示结束标签', async () => {
  const core = { settings: { read: () => Promise.resolve({ 'site.locale': 'zh-CN' }) } } as unknown as Core
  const app = new OpenAPIHono<AppEnv>()
  const respond = createErrorResponse(core)
  app.get('/api/admin/settings', (c) => respond(c, 'custom_css_invalid'))
  expect(restErrorCode(new DomainError('custom_css_invalid'))).toBe('custom_css_invalid')
  for (const locale of ['zh-CN', 'en']) {
    const response = await app.request('http://example.test/api/admin/settings', {
      headers: { 'accept-language': locale },
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { code: string; message: string; fields: Record<string, { code: string; message: string }> }
    }
    expect(body.error.message).toContain('</style')
    expect(body.error.fields['custom.css']).toEqual({ code: 'custom_css_invalid', message: body.error.message })
  }
})
