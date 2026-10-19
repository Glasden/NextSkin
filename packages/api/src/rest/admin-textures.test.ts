import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { createTranslator, getMessages, locales, type Locale } from '@nextskin/i18n'
import { expect, test, vi, type Mock } from 'vitest'
import { createApp } from '../app.ts'

const methods = ['updateTexture', 'unpublishTexture'] as const
type Method = (typeof methods)[number]
const actor = { uid: 42, ip: '192.0.2.10' }
const texture = {
  tid: 7,
  name: 'Skin',
  type: 'alex',
  hash: 'a'.repeat(64),
  width: 64,
  height: 64,
  sizeBytes: 100,
  uploader: 8,
  public: false,
  description: null,
  likes: 0,
  uploadedAt: '2026-01-01T00:00:00.000Z',
}
const endpoints = [
  {
    method: 'PATCH',
    path: '/admin/textures/7',
    body: { name: 'Skin', type: 'alex', description: null },
    fn: 'updateTexture',
    args: [actor, 7, { name: 'Skin', type: 'alex', description: null }],
  },
  { method: 'POST', path: '/admin/textures/7/unpublish', body: undefined, fn: 'unpublishTexture', args: [actor, 7] },
] as const

function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi.fn().mockResolvedValue({
    uid: actor.uid,
    sessionId: 1,
    nickname: 'Admin',
    email: 'admin@example.test',
    role: 'admin',
    locale: null,
  })
  const admin = Object.fromEntries(methods.map((name) => [name, vi.fn()])) as Record<Method, Mock>
  const core = { settings: { read }, auth: { getSessionUser }, admin } as unknown as Core
  const app = createApp({ core })
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(
      `http://example.test/api${path}`,
      {
        method,
        headers: {
          origin: 'http://example.test',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { peer: actor.ip },
    )
  return { app, request, admin, getSessionUser }
}
function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  return (createTranslator(locale) as unknown as (key: string, params?: Record<string, string | number>) => string)(
    key,
    params,
  )
}

test.each(endpoints)('$method $path 返回材质，操作者来自会话和对端地址', async (endpoint) => {
  const { request, admin } = setup()
  admin[endpoint.fn].mockResolvedValue(texture)
  const response = await request(endpoint.method, endpoint.path, endpoint.body)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(texture)
  expect(admin[endpoint.fn]).toHaveBeenCalledExactlyOnceWith(...endpoint.args)
})

test.each([{ name: 'Skin' }, { type: 'cape' }, { description: '描述' }, { description: null }])(
  '单项修改通过 refine：%j',
  async (body) => {
    const { request, admin } = setup()
    admin.updateTexture.mockResolvedValue(texture)
    expect((await request('PATCH', '/admin/textures/2147483647', body)).status).toBe(200)
    expect(admin.updateTexture).toHaveBeenCalledExactlyOnceWith(actor, 2147483647, body)
  },
)

const invalid = [
  ['缺少请求体', 'PATCH', '/admin/textures/7', undefined],
  ['空请求体', 'PATCH', '/admin/textures/7', {}],
  ['只有公开状态', 'PATCH', '/admin/textures/7', { public: true }],
  ['名字不是字符串', 'PATCH', '/admin/textures/7', { name: null }],
  ['未知模型', 'PATCH', '/admin/textures/7', { type: 'skin' }],
  ['描述不是字符串', 'PATCH', '/admin/textures/7', { description: 1 }],
  ...['0', '-1', '1.2', '1e2', '2147483648', '7x'].flatMap(
    (tid) =>
      [
        [`修改的 tid 为 ${tid}`, 'PATCH', `/admin/textures/${tid}`, { name: 'Skin' }],
        [`下架的 tid 为 ${tid}`, 'POST', `/admin/textures/${tid}/unpublish`, undefined],
      ] as const,
  ),
] as const
const failures = [
  ['permission_denied', 403, 'updateTexture', {}],
  ['admin_own_texture', 403, 'updateTexture', {}],
  ['texture_not_found', 404, 'updateTexture', {}],
  ['texture_type_invalid', 400, 'updateTexture', {}],
  ['texture_name_invalid', 400, 'updateTexture', {}],
  ['texture_name_length', 400, 'updateTexture', { min: 1, max: 128 }],
  ['texture_description_too_long', 400, 'updateTexture', { max: 2000 }],
  ['permission_denied', 403, 'unpublishTexture', {}],
  ['admin_own_texture', 403, 'unpublishTexture', {}],
  ['texture_not_found', 404, 'unpublishTexture', {}],
  ['texture_uploader_gone', 409, 'unpublishTexture', {}],
] as const

test.each(endpoints)('$method $path 没有会话返回 401，不调用用例', async (endpoint) => {
  const { request, admin, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  const response = await request(endpoint.method, endpoint.path, endpoint.body)
  expect(response.status).toBe(401)
  for (const name of methods) expect(admin[name]).not.toHaveBeenCalled()
})

test.each(invalid)('%s：400 invalid_request，不调用用例', async (_name, method, path, body) => {
  const { request, admin } = setup()
  const response = await request(method, path, body)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  for (const name of methods) expect(admin[name]).not.toHaveBeenCalled()
})

test.each(failures)('%s（%s）由 %s 抛出时映射状态码和文案', async (code, status, fn, params) => {
  const endpoint = endpoints.find((candidate) => candidate.fn === fn)!
  for (const locale of locales) {
    const { request, admin } = setup()
    admin[fn].mockRejectedValue(new DomainError(code, params))
    const response = await request(endpoint.method, endpoint.path, endpoint.body, { 'accept-language': locale })
    expect(response.status).toBe(status)
    const override: Record<string, string> = getMessages(locale).admin.errors
    expect(await response.json()).toMatchObject({
      error: {
        code,
        message: translate(locale, Object.hasOwn(override, code) ? `admin.errors.${code}` : `errors.${code}`, params),
      },
    })
    const field =
      code === 'texture_type_invalid'
        ? 'type'
        : code.startsWith('texture_name_')
          ? 'name'
          : code === 'texture_description_too_long'
            ? 'description'
            : undefined
    if (field) {
      admin[fn].mockRejectedValue(new DomainError(code, params))
      const withField = await request(endpoint.method, endpoint.path, endpoint.body)
      expect(await withField.json()).toMatchObject({ error: { fields: { [field]: { code } } } })
    }
  }
})

test('OpenAPI 在材质路径声明查询、修改和删除，并声明下架', async () => {
  const { app } = setup()
  const spec = (await (await app.request('http://example.test/api/openapi.json')).json()) as {
    paths: Record<string, object>
  }
  expect(Object.keys(spec.paths['/admin/textures/{tid}']!).sort()).toEqual(['delete', 'get', 'patch'])
  expect(Object.keys(spec.paths['/admin/textures/{tid}/unpublish']!)).toEqual(['post'])
})
