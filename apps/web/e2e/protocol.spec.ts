import { expect, test } from '@playwright/test'

// 协议响应本身由 e2e/contract.spec.ts 回放契约用例守护；这里只测 Next 这一层的行为。

test('/api/yggdrasil/ 不被 308 跳转（authlib-injector 请求元数据时带斜杠）', async ({ request }) => {
  for (const path of ['/api/yggdrasil', '/api/yggdrasil/']) {
    const res = await request.get(path, { maxRedirects: 0 })
    expect(res.status(), path).toBe(200)
    expect((await res.json()) as unknown).toHaveProperty('signaturePublickey')
  }
})

test('页面带 X-Authlib-Injector-API-Location，启动器填首页地址就能找到 API', async ({ request }) => {
  const res = await request.get('/')
  expect(res.status()).toBe(200)
  expect(res.headers()['x-authlib-injector-api-location']).toBe('http://localhost:3100/api/yggdrasil')
})

test.describe('X-Authlib-Injector-API-Location 每个响应恰好一个', () => {
  // Next 自己的 404 页由 proxy 加；进入 Hono 的路径由 Hono 加，proxy 不能再加一次
  for (const path of [
    '/api',
    '/textures/',
    '/skin/Steve.jpg',
    '/csl',
    '/Nobody.json',
    '/textures/abc',
    `/render/v1/head/1/${'0'.repeat(64)}.png`,
    `/site-images/${'0'.repeat(64)}.png`,
    '/plugins/no-such-plugin/anything',
    '/no-such-page',
  ]) {
    test(path, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 })
      const values = res
        .headersArray()
        .filter((header) => header.name.toLowerCase() === 'x-authlib-injector-api-location')
      expect(values.map((header) => header.value)).toEqual(['http://localhost:3100/api/yggdrasil'])
    })
  }
})
