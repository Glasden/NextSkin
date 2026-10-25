import { coreSettingsRegistry, type Core, type CoreSettingKey } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { createApp } from './app.ts'
import type { ImportGateway } from './import-gateway.ts'

function setup(content = '', maintenance = false, importing = false) {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(
      Object.fromEntries(
        keys.map((key) => [
          key,
          key === 'custom.adsTxt'
            ? content
            : key === 'maintenance.enabled'
              ? maintenance
              : coreSettingsRegistry[key].default,
        ]),
      ),
    ),
  )
  const core = { settings: { read }, auth: { getSessionUser: vi.fn() } } as unknown as Core
  const importer = { maintenance: () => importing } as ImportGateway
  return { app: createApp({ core, importer }), read }
}

test('GET 返回原文和公开缓存、纯文本与 nosniff 响应头；HEAD 没有正文', async () => {
  const content = '  example.com, pub-test, DIRECT\n'
  const { app } = setup(content)
  for (const method of ['GET', 'HEAD']) {
    const response = await app.request('https://example.test/ads.txt', { method })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe(method === 'HEAD' ? '' : content)
  }
})

test.each(['', ' \n\t '])('没有内容时 GET 和 HEAD 返回 404：%j', async (content) => {
  const { app } = setup(content)
  for (const method of ['GET', 'HEAD']) {
    const response = await app.request('https://example.test/ads.txt', { method })
    expect(response.status).toBe(404)
    if (method === 'HEAD') expect(await response.text()).toBe('')
  }
})

test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('不支持的方法返回 405：%s', async (method) => {
  const { app, read } = setup('ad network')
  const response = await app.request('https://example.test/ads.txt', { method })
  expect(response.status).toBe(405)
  expect(read.mock.calls.some(([keys]) => keys.includes('custom.adsTxt'))).toBe(false)
})

test('手动维护期间允许爬虫读取；导入期间返回 503，不读取设置', async () => {
  const manual = setup('ad network', true)
  expect((await manual.app.request('https://example.test/ads.txt')).status).toBe(200)
  const importing = setup('ad network', false, true)
  const response = await importing.app.request('https://example.test/ads.txt')
  expect(response.status).toBe(503)
  expect(response.headers.get('retry-after')).toBe('30')
  expect(importing.read).not.toHaveBeenCalled()
})
