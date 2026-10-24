import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey, type UpdateStatus } from '@nextskin/domain'
import { createTranslator, locales } from '@nextskin/i18n'
import { expect, test, vi } from 'vitest'
import { createApp } from '../app.ts'

const actor = { uid: 42, ip: '192.0.2.10' }
const result: UpdateStatus = {
  manager: { available: false, reason: 'docker' },
  enabled: true,
  current: '0.4.0',
  deployment: 'docker',
  checkedAt: '2026-10-23T00:00:00.000Z',
  failure: { at: '2026-10-23T00:01:00.000Z', code: 'http', status: 503 },
  latest: {
    version: '0.5.0',
    date: '2026-10-23T00:00:00.000Z',
    notes: 'https://example.test/notes',
    minNode: 24,
    managerProtocol: 1,
  },
  target: null,
}
function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi.fn().mockResolvedValue({ uid: actor.uid, role: 'superadmin', locale: null })
  const updates = {
    status: vi.fn().mockResolvedValue(result),
    check: vi.fn().mockResolvedValue(result),
    prepare: vi.fn().mockResolvedValue({ accepted: true }),
    apply: vi.fn().mockResolvedValue({ accepted: true }),
    rollback: vi.fn().mockResolvedValue({ accepted: true }),
    cancel: vi.fn().mockResolvedValue({ cancelled: true }),
  }
  const app = createApp({ core: { settings: { read }, auth: { getSessionUser }, updates } as unknown as Core })
  const request = (method: string, path: string, locale = 'zh-CN', origin = 'http://example.test', body?: unknown) =>
    app.request(
      `http://example.test/api/admin/updates${path}`,
      {
        method,
        headers: {
          origin,
          'accept-language': locale,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
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
test('OpenAPI 注册六个端点并声明状态结构', async () => {
  const { app } = setup()
  const spec = (await (await app.request('http://example.test/api/openapi.json')).json()) as {
    paths: Record<string, Record<string, unknown>>
  }
  expect(spec.paths['/admin/updates']).toHaveProperty('get')
  expect(spec.paths['/admin/updates/check']).toHaveProperty('post')
  for (const method of ['prepare', 'apply', 'rollback', 'cancel'])
    expect(spec.paths[`/admin/updates/${method}`]).toHaveProperty('post')
  expect(JSON.stringify(spec.paths['/admin/updates'])).toContain('minNode')
  expect(JSON.stringify(spec.paths['/admin/updates'])).toContain('manager')
})

const commands = [
  ['prepare', { version: '0.5.0' }, [actor, '0.5.0']],
  ['apply', { version: '0.5.0', backupConfirmed: true }, [actor, '0.5.0', { backupConfirmed: true }]],
  ['rollback', { confirmed: true }, [actor, { confirmed: true }]],
  ['cancel', undefined, [actor]],
] as const
test.each(commands)('%s 返回确认结构，并传递操作者和参数', async (method, body, args) => {
  const { request, updates } = setup()
  const response = await request('POST', `/${method}`, 'zh-CN', 'http://example.test', body)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(method === 'cancel' ? { cancelled: true } : { accepted: true })
  expect(updates[method]).toHaveBeenCalledExactlyOnceWith(...args)
})
test.each(commands)('%s 无会话、权限不足或不同源都被拒绝', async (method, body) => {
  const { request, updates, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  expect((await request('POST', `/${method}`, 'zh-CN', 'http://example.test', body)).status).toBe(401)
  expect(updates[method]).not.toHaveBeenCalled()
  getSessionUser.mockResolvedValue({ uid: actor.uid, role: 'admin', locale: null })
  updates[method].mockRejectedValue(new DomainError('permission_denied'))
  expect((await request('POST', `/${method}`, 'zh-CN', 'http://example.test', body)).status).toBe(403)
  updates[method].mockClear()
  expect((await request('POST', `/${method}`, 'zh-CN', 'https://other.test')).status).toBe(403)
  expect(updates[method]).not.toHaveBeenCalled()
})
test.each([
  ['prepare', {}],
  ['prepare', { version: '1.2.3-rc.1' }],
  ['prepare', { version: '1.2.3\n' }],
  ['prepare', { version: 123 }],
  ['apply', { version: '0.5.0' }],
  ['apply', { version: '0.5.0', backupConfirmed: 'true' }],
  ['apply', { version: '0.5.0', backupConfirmed: 1 }],
  ['rollback', {}],
  ['rollback', { confirmed: 'false' }],
  ['rollback', { confirmed: null }],
] as const)('%s 请求体严格校验 %#', async (method, body) => {
  const { request, updates } = setup()
  const response = await request('POST', `/${method}`, 'en', 'http://example.test', body)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  expect(updates[method]).not.toHaveBeenCalled()
})
test.each(['prepare', 'apply', 'rollback'] as const)('%s 要求 JSON 请求体', async (method) => {
  const { request, updates } = setup()
  expect((await request('POST', `/${method}`)).status).toBe(400)
  expect(updates[method]).not.toHaveBeenCalled()
})
const errorStatuses = {
  update_unreachable: 503,
  update_invalid_request: 400,
  update_unauthorized: 500,
  invalid_request: 400,
  update_busy: 409,
  update_readonly: 409,
  update_not_prepared: 409,
  update_not_newer: 409,
  update_unknown_version: 400,
  update_manager_outdated: 409,
  update_node_too_old: 409,
  update_backup_required: 400,
  update_offline_required: 409,
  update_confirmation_required: 400,
  update_no_previous: 409,
  update_backup_missing: 409,
  update_preflight_failed: 409,
  update_download_failed: 503,
  update_internal: 500,
} as const
test.each(Object.entries(errorStatuses))('%s 返回 HTTP %s 和双语兜底', async (rawCode, status) => {
  const code = rawCode as keyof typeof errorStatuses
  for (const locale of locales) {
    const { request, updates } = setup()
    updates.apply.mockRejectedValue(new DomainError(code))
    const response = await request('POST', '/apply', locale, 'http://example.test', {
      version: '0.5.0',
      backupConfirmed: false,
    })
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({
      error: { code, message: createTranslator(locale)(`errors.${code}`) },
    })
  }
})
test('中文界面优先显示管理进程的具体说明，空消息和别的语言用兜底文案', async () => {
  const { request, updates } = setup()
  updates.prepare.mockRejectedValue(new DomainError('update_preflight_failed', { message: '目标版本有不兼容插件' }))
  const response = await request('POST', '/prepare', 'zh-CN', 'http://example.test', { version: '0.5.0' })
  expect(await response.json()).toEqual({ error: { code: 'update_preflight_failed', message: '目标版本有不兼容插件' } })
  const english = await request('POST', '/prepare', 'en', 'http://example.test', { version: '0.5.0' })
  expect(await english.json()).toEqual({
    error: { code: 'update_preflight_failed', message: createTranslator('en')('errors.update_preflight_failed') },
  })
  updates.prepare.mockRejectedValue(new DomainError('update_internal', { message: '' }))
  const fallback = await request('POST', '/prepare', 'zh-CN', 'http://example.test', { version: '0.5.0' })
  expect(await fallback.json()).toEqual({
    error: { code: 'update_internal', message: createTranslator('zh-CN')('errors.update_internal') },
  })
})
test.each(['invalid_request', 'update_invalid_request'] as const)(
  '%s 区分核心校验和管理进程拒绝的消息',
  async (code) => {
    const { request, updates } = setup()
    updates.prepare.mockRejectedValue(new DomainError(code, { message: '管理进程的具体原因' }))
    const response = await request('POST', '/prepare', 'zh-CN', 'http://example.test', { version: '0.5.0' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code,
        message:
          code === 'update_invalid_request'
            ? '管理进程的具体原因'
            : createTranslator('zh-CN')('errors.invalid_request'),
      },
    })
  },
)
test('status 返回完整的可用管理进程结构', async () => {
  const { request, updates } = setup()
  const manager = {
    available: true,
    protocol: 1,
    version: '0.4.0',
    current: '0.4.0',
    previous: null,
    writable: true,
    operation: null,
    prepared: null,
    lastResult: null,
    failed: [],
    rollback: null,
  }
  updates.status.mockResolvedValue({ ...result, manager })
  expect(await (await request('GET', '')).json()).toEqual({ ...result, manager })
})
