import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi.fn().mockResolvedValue({ uid: 42, role: 'superadmin', locale: null })
  const page = { available: true, entries: [{ id: 'a:0', line: 'raw', record: null }], next: null, scanLimited: false }
  const diagnostics = {
    logs: vi.fn().mockResolvedValue(page),
    export: vi
      .fn()
      .mockResolvedValue({ filename: 'nextskin-diagnostics-20261024T153012Z.zip', body: new Uint8Array([80, 75]) }),
  }
  const app = createApp({ core: { settings: { read }, auth: { getSessionUser }, diagnostics } as unknown as Core })
  const request = (method: string, path: string, origin = 'http://example.test') =>
    app.request(
      `http://example.test/api/admin/diagnostics${path}`,
      { method, headers: { origin } },
      { peer: '192.0.2.10' },
    )
  return { app, diagnostics, getSessionUser, request, page }
}
const actor = { uid: 42, ip: '192.0.2.10' }
test('GET 映射参数、返回原始内容和 no-store，actor 来自会话和连接地址', async () => {
  const { request, diagnostics, page } = setup()
  const response = await request('GET', '/logs?level=warn&source=plugin&q=example&cursor=opaque')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(page)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(diagnostics.logs).toHaveBeenCalledExactlyOnceWith(actor, {
    level: 'warn',
    source: 'plugin',
    text: 'example',
    cursor: 'opaque',
  })
})
test.each([
  '/logs?level=trace',
  '/logs?q=' + 'x'.repeat(1025),
  '/logs?source=' + 'x'.repeat(257),
  '/logs?cursor=' + 'x'.repeat(40001),
])('GET 校验失败：%s', async (path) => {
  const { request, diagnostics } = setup()
  expect((await request('GET', path)).status).toBe(400)
  expect(diagnostics.logs).not.toHaveBeenCalled()
})
test('POST 返回 zip 字节及下载头', async () => {
  const { request, diagnostics } = setup()
  const response = await request('POST', '/export')
  expect(response.status).toBe(200)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([80, 75]))
  expect(response.headers.get('content-type')).toBe('application/zip')
  expect(response.headers.get('content-disposition')).toBe(
    'attachment; filename="nextskin-diagnostics-20261024T153012Z.zip"',
  )
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(diagnostics.export).toHaveBeenCalledExactlyOnceWith(actor)
})
test.each([
  ['GET', '/logs', 'logs'],
  ['POST', '/export', 'export'],
] as const)('%s 无会话与领域权限拒绝', async (method, path, fn) => {
  const { request, diagnostics, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request(method, path)).status).toBe(401)
  expect(diagnostics[fn]).not.toHaveBeenCalled()
  getSessionUser.mockResolvedValue({ uid: 42, role: 'admin', locale: null })
  diagnostics[fn].mockRejectedValue(new DomainError('permission_denied'))
  expect((await request(method, path)).status).toBe(403)
})
test('非法游标经已有 invalid_request 返回 400；导出经过同源检查', async () => {
  const { request, diagnostics } = setup()
  diagnostics.logs.mockRejectedValue(new DomainError('invalid_request', undefined, ['cursor']))
  const response = await request('GET', '/logs?cursor=bad')
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { code: 'invalid_request', fields: { cursor: { code: 'invalid_value' } } },
  })
  expect((await request('POST', '/export', 'https://other.test')).status).toBe(403)
  expect(diagnostics.export).not.toHaveBeenCalled()
})
test('OpenAPI 声明日志页、查询、zip 和下载头', async () => {
  const { app } = setup()
  const spec = (await (await app.request('http://example.test/api/openapi.json')).json()) as {
    paths: Record<string, unknown>
  }
  const logs = JSON.stringify(spec.paths['/admin/diagnostics/logs'])
  expect(logs).toContain('scanLimited')
  expect(logs).toContain('cursor')
  expect(logs).toContain('record')
  const bundle = JSON.stringify(spec.paths['/admin/diagnostics/export'])
  expect(bundle).toContain('application/zip')
  expect(bundle).toContain('Content-Disposition')
})
