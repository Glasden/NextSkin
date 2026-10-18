import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'
import { createRestApp } from './app.ts'
import { createMemoryRateLimiter } from './rate-limit.ts'
import { Hono } from 'hono'
import type { AppEnv } from '../env.ts'

const texture = {
  tid: 1,
  name: 'Test',
  type: 'steve',
  hash: 'a'.repeat(64),
  width: 64,
  height: 64,
  sizeBytes: 100,
  uploader: 42,
  public: true,
  description: null,
  likes: 1,
  uploadedAt: '2026-10-18T00:00:00.000Z',
}
function setup(max = 1024) {
  const upload = vi.fn().mockResolvedValue({ texture, charged: 1 }),
    update = vi.fn().mockResolvedValue({ texture, scoreDelta: 0 }),
    remove = vi.fn().mockResolvedValue({ refunded: 1 })
  const getSessionUser = vi.fn().mockResolvedValue({ uid: 42, role: 'user' })
  const read = vi.fn((keys: CoreSettingKey[]) =>
    Promise.resolve(
      Object.fromEntries(
        keys.map((key) => [key, key === 'texture.maxFileSizeKb' ? max : coreSettingsRegistry[key].default]),
      ),
    ),
  )
  const core = {
    settings: { read },
    auth: { getSessionUser },
    textures: { upload, update, delete: remove },
  } as unknown as Core
  const app = createApp({ core })
  const form = (size = 100) => {
    const data = new FormData()
    data.set('file', new File([new Uint8Array(size)], 'skin.png', { type: 'image/png' }))
    data.set('name', 'Test')
    data.set('type', 'steve')
    data.set('public', 'true')
    data.set('description', 'D')
    return data
  }
  const request = (
    method = 'POST',
    path = '/api/textures',
    body: FormData | string | undefined = form(),
    headers = {},
  ) =>
    app.request(`http://example.test${path}`, {
      method,
      headers: { origin: 'http://example.test', ...headers },
      ...(body === undefined ? {} : { body }),
    })
  return { app, core, read, upload, update, remove, getSessionUser, form, request }
}
test('multipart 上传成功，解析布尔与文件字节，响应 201', async () => {
  const { request, upload } = setup()
  const response = await request()
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ texture, charged: 1 })
  expect(upload).toHaveBeenCalledWith(
    { uid: 42 },
    { name: 'Test', type: 'steve', public: true, description: 'D', bytes: new Uint8Array(100) },
  )
})
test.each([
  ['texture_not_found', 404, undefined],
  ['texture_not_owned', 403, undefined],
  ['texture_duplicate', 409, undefined],
  ['texture_file_too_large', 413, 'file'],
  ['texture_file_invalid', 400, 'file'],
  ['texture_size_invalid', 400, 'file'],
  ['texture_name_length', 400, 'name'],
  ['texture_name_invalid', 400, 'name'],
  ['texture_description_too_long', 400, 'description'],
  ['texture_type_invalid', 400, 'type'],
  ['texture_name_rule_misconfigured', 500, undefined],
  ['score_insufficient', 403, undefined],
  ['user_banned', 403, undefined],
  ['email_not_verified', 403, undefined],
  ['service_unavailable', 503, undefined],
] as const)('领域错误 %s 的状态与字段', async (code, status, field) => {
  const { request, upload } = setup()
  upload.mockRejectedValue(
    new DomainError(code, { tid: 3, max: 1024, min: 1, width: 1, height: 2, required: 1, balance: 0 }),
  )
  const response = await request()
  expect(response.status).toBe(status)
  const body = (await response.json()) as { error: { code: string; fields?: Record<string, { code: string }> } }
  expect(body.error.code).toBe(code)
  if (field) expect(body.error.fields?.[field]?.code).toBe(code)
  else expect(body.error.fields).toBeUndefined()
})
test('上传只接受 multipart；字段缺失和非法布尔返回 400；缺登录为 401', async () => {
  const { request, form, upload, getSessionUser } = setup()
  for (const contentType of ['application/json', 'text/plain', 'application/x-www-form-urlencoded'])
    expect((await request('POST', '/api/textures', '{}', { 'content-type': contentType })).status).toBe(415)
  for (const field of ['file', 'name', 'type', 'public']) {
    const body = form()
    body.delete(field)
    const response = await request('POST', '/api/textures', body)
    expect(response.status).toBe(400)
    expect(await response.json()).toHaveProperty(`error.fields.${field}`)
  }
  const invalid = form()
  invalid.set('public', '1')
  expect((await request('POST', '/api/textures', invalid)).status).toBe(400)
  getSessionUser.mockResolvedValue(null)
  expect((await request()).status).toBe(401)
  expect(upload).not.toHaveBeenCalled()
})
test('独立大小上限：可超过 16KB；文件和整个表单分别检查；实时读取设置', async () => {
  const { request, form, upload, read } = setup(32)
  expect((await request('POST', '/api/textures', form(20 * 1024))).status).toBe(201)
  for (const size of [32 * 1024 + 1, 100 * 1024]) {
    const response = await request('POST', '/api/textures', form(size))
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: 'texture_file_too_large', fields: { file: { code: 'texture_file_too_large' } } },
    })
  }
  expect(upload).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledWith(['texture.maxFileSizeKb'])
})
test('即使伪造较小 Content-Length，流超限仍返回材质的 413', async () => {
  const { request, form, upload } = setup(1)
  expect((await request('POST', '/api/textures', form(100 * 1024), { 'content-length': '1' })).status).toBe(413)
  expect(upload).not.toHaveBeenCalled()
})
test('Origin 检查继续保护 multipart', async () => {
  const { app, request, form, upload } = setup()
  expect((await app.request('http://example.test/api/textures', { method: 'POST', body: form() })).status).toBe(403)
  expect(
    (await request('POST', '/api/textures', form(), { origin: 'https://evil.test', 'sec-fetch-site': 'same-origin' }))
      .status,
  ).toBe(403)
  expect(upload).not.toHaveBeenCalled()
})
test('每分钟每用户最多 10 次；uid 为限流键；自定义上传限流器和旧默认互不影响', async () => {
  const { request, getSessionUser, core, form } = setup()
  for (let i = 0; i < 10; i++) expect((await request()).status).toBe(201)
  const limited = await request()
  expect(limited.status).toBe(429)
  expect(limited.headers.get('retry-after')).toBeTruthy()
  getSessionUser.mockResolvedValue({ uid: 43, role: 'user' })
  expect((await request()).status).toBe(201)
  const consume = vi.fn().mockReturnValue({ allowed: false, retryAfter: 12 })
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('requestRoot', 'http://example.test')
    await next()
  })
  app.route('/api', createRestApp(core, { uploadRateLimiter: { consume } }))
  expect(
    (
      await app.request('http://example.test/api/textures', {
        method: 'POST',
        headers: { origin: 'http://example.test' },
        body: form(),
      })
    ).status,
  ).toBe(429)
  expect(consume).toHaveBeenCalledWith('texture-upload:43')
  let clock = 0
  const limiter = createMemoryRateLimiter(() => clock, { limit: 10, windowMs: 60_000 })
  for (let i = 0; i < 10; i++) expect(limiter.consume('42').allowed).toBe(true)
  expect(limiter.consume('42').allowed).toBe(false)
  clock = 60000
  expect(limiter.consume('42').allowed).toBe(true)
})
test('PATCH 和 DELETE 转交会话身份，校验 tid 与 JSON，未登录拒绝', async () => {
  const { request, update, remove, getSessionUser } = setup()
  const patch = { name: 'Renamed', type: 'alex', public: false, description: null }
  const result = await request('PATCH', '/api/textures/1', JSON.stringify(patch), {
    'content-type': 'application/json',
  })
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ texture, scoreDelta: 0 })
  expect(update).toHaveBeenCalledWith({ uid: 42 }, 1, patch)
  // request 的默认 body 是表单，空 DELETE 显式用空字符串。
  expect((await request('DELETE', '/api/textures/1', '')).status).toBe(200)
  expect(remove).toHaveBeenCalledWith({ uid: 42 }, 1)
  for (const tid of ['0', '-1', 'abc', '1e2', '9007199254740992'])
    expect((await request('DELETE', `/api/textures/${tid}`, '')).status).toBe(400)
  expect(
    (
      await request('PATCH', '/api/textures/1', JSON.stringify({ public: 'true' }), {
        'content-type': 'application/json',
      })
    ).status,
  ).toBe(400)
  getSessionUser.mockResolvedValue(null)
  expect((await request('PATCH', '/api/textures/1', '{}', { 'content-type': 'application/json' })).status).toBe(401)
  expect((await request('DELETE', '/api/textures/1', '')).status).toBe(401)
})
