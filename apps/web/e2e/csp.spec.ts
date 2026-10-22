import type { APIResponse } from '@playwright/test'
import { expect, test } from './fixtures'

function pageNonce(response: APIResponse) {
  expect(response.status()).toBe(200)
  expect(response.headers()['x-frame-options']).toBe('DENY')
  const policy = response.headers()['content-security-policy']
  const match = policy?.match(
    /^script-src 'nonce-([A-Za-z0-9+/]{22}==)' 'strict-dynamic'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/,
  )
  expect(match).toBeTruthy()
  return match![1]!
}

function expectNoPagePolicy(response: APIResponse) {
  expect(response.headers()['content-security-policy'] ?? '').not.toContain('strict-dynamic')
}

test('首页每次请求用不同的 nonce，所有脚本都带本次的 nonce', async ({ request }) => {
  const nonces: string[] = []
  for (let i = 0; i < 2; i++) {
    const response = await request.get('/')
    const nonce = pageNonce(response)
    nonces.push(nonce)
    const scripts = [...(await response.text()).matchAll(/<script\b[^>]*>/gi)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const [script] of scripts) expect(script).toContain(` nonce="${nonce}"`)
  }
  expect(nonces[0]).not.toBe(nonces[1])
})

for (const path of ['/sign-in', '/skinlib']) {
  test(`${path} 同样带严格 CSP 和禁止嵌入的响应头`, async ({ request }) => {
    pageNonce(await request.get(path))
  })
}

test('进入 Hono 的协议和接口响应不带页面的 CSP', async ({ request }) => {
  for (const path of ['/api/yggdrasil', '/api/health', '/no-such-player-xyz.json']) {
    expectNoPagePolicy(await request.get(path))
  }
})

test('注入页面的内联脚本和事件处理属性都不执行，违规能收集到', async ({ page, cspViolations }) => {
  // 模拟 HTML 注入：响应头不变，往页面里写一段不带 nonce 的脚本和一个 onerror。
  // 不能用 addScriptTag：脚本创建的 <script> 由 'strict-dynamic' 放行，浏览器分不出是谁创建的
  await page.route('/', async (route) => {
    const response = await route.fetch()
    const html = await response.text()
    const end = html.lastIndexOf('</body>')
    const injected =
      '<script>window.__cspInjected = true</script><img src="data:," onerror="window.__cspInjected = true">'
    await route.fulfill({ response, body: html.slice(0, end) + injected + html.slice(end) })
  })
  await page.goto('/')
  await expect
    .poll(() => cspViolations.map((violation) => violation.effectiveDirective).sort())
    .toEqual(['script-src-attr', 'script-src-elem'])
  expect(await page.evaluate(() => (window as Window & { __cspInjected?: boolean }).__cspInjected)).toBeUndefined()
  cspViolations.length = 0
})
