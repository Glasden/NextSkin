import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey, type UpdateStatus } from '@nextskin/domain'
import { createTranslator, locales } from '@nextskin/i18n'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

const actor = { uid: 42, ip: '192.0.2.10' }
const result: UpdateStatus = {
  enabled: true,
  current: '0.4.0',
  deployment: 'docker',
  checkedAt: '2026-10-23T00:00:00.000Z',
  failure: { at: '2026-10-23T00:01:00.000Z', code: 'http', status: 503 },
  latest: { version: '0.5.0', date: '2026-10-23T00:00:00.000Z', notes: 'https://example.test/notes', minNode: 24 },
}
function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi.fn().mockResolvedValue({ uid: actor.uid, role: 'superadmin', locale: null })
  const updates = { status: vi.fn().mockResolvedValue(result), check: vi.fn().mockResolvedValue(result) }
  const app = createApp({ core: { settings: { read }, auth: { getSessionUser }, updates } as unknown as Core })
  const request = (method: string, path: string, locale = 'zh-CN', origin = 'http://example.test') =>
    app.request(
      `http://example.test/api/admin/updates${path}`,
      { method, headers: { origin, 'accept-language': locale } },
      { peer: actor.ip },
    )
  return { app, request, updates, getSessionUser }
}
const endpoints = [
  ['GET', '', 'status'],
  ['POST', '/check', 'check'],
] as const

test.each(endpoints)('%s 鉴权后传入会话操作者并返回完整状态', async (method, path, fn) => {
  const { request, updates } = setup()
  const response = await request(method, path)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(result)
  expect(updates[fn]).toHaveBeenCalledExactlyOnceWith(actor)
})
test.each(endpoints)('%s 没有会话时拒绝访问', async (method, path) => {
  const { request, updates, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request(method, path)).status).toBe(401)
  expect(updates.status).not.toHaveBeenCalled()
  expect(updates.check).not.toHaveBeenCalled()
})
test.each(endpoints)('%s 领域权限拒绝映射为 403', async (method, path, fn) => {
  const { request, updates } = setup()
  updates[fn].mockRejectedValue(new DomainError('permission_denied'))
  expect((await request(method, path)).status).toBe(403)
})
test.each(['updates_disabled', 'updates_unavailable'] as const)('%s 返回 409 和双语文案', async (code) => {
  for (const locale of locales) {
    const { request, updates } = setup()
    updates.check.mockRejectedValue(new DomainError(code))
    const response = await request('POST', '/check', locale)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code, message: createTranslator(locale)(`errors.${code}`) },
    })
  }
})
test('立即检查经过同源检查', async () => {
  const { request, updates } = setup()
  expect((await request('POST', '/check', 'en', 'https://other.test')).status).toBe(403)
  expect(updates.check).not.toHaveBeenCalled()
})
test('OpenAPI 注册两个端点并声明状态结构', async () => {
  const { app } = setup()
  const spec = (await (await app.request('http://example.test/api/openapi.json')).json()) as {
    paths: Record<string, Record<string, unknown>>
  }
  expect(spec.paths['/admin/updates']).toHaveProperty('get')
  expect(spec.paths['/admin/updates/check']).toHaveProperty('post')
  expect(JSON.stringify(spec.paths['/admin/updates'])).toContain('minNode')
})
