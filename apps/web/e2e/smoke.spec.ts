import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from './fixtures'

test('首页能打开', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'NextSkin' }).first()).toHaveAttribute('href', '/')
})

// ADR-0008：发行包里没有原生模块和动态库，同一个 ZIP 能在任何系统和架构上运行。sharp 这类可选依赖一装上，
// 就会被 Turbopack 追踪进产物（见 pnpm-workspace.yaml 的 overrides）
test('standalone 产物里没有原生模块和动态库', () => {
  const files = readdirSync(new URL('../.next/standalone/', import.meta.url), { recursive: true, encoding: 'utf8' })
  expect(files.filter((file) => /\.(?:node|so(?:\.\d+)*|dylib|dll)$/.test(file))).toEqual([])
})

// 语言按 Cookie → Accept-Language → 站点默认的顺序解析，URL 不带语言前缀（ADR-0019）
test('页面语言按 Cookie 和 Accept-Language 解析', async ({ request }) => {
  const lang = async (headers: Record<string, string>) =>
    /<html[^>]* lang="([^"]+)"/.exec(await (await request.get('/', { headers })).text())?.[1]
  expect(await lang({ 'accept-language': 'en-US,en;q=0.9' })).toBe('en')
  expect(await lang({ 'accept-language': 'ja, zh-TW;q=0.8' })).toBe('zh-CN')
  expect(await lang({ 'accept-language': 'en', cookie: 'nextskin-locale=zh-CN' })).toBe('zh-CN')
  expect(await lang({ 'accept-language': 'ja' })).toBe('zh-CN')
})

// 字体分片由 @nextskin/ui 的 CSS 引用，靠 Tailwind 内联 @import 时改写相对路径、Turbopack 再把文件打进产物
test('像素字体的每个分片都随样式表发布', async ({ page, request }) => {
  const source = readFileSync(new URL('../../../packages/ui/src/fonts/fonts.css', import.meta.url), 'utf8')
  const expected = source.match(/@font-face/g)?.length

  await page.goto('/')
  const sheets = await page.evaluate(() => [...document.styleSheets].flatMap((sheet) => sheet.href ?? []))
  const fonts = new Set<string>()
  for (const href of sheets) {
    const css = await (await request.get(href)).text()
    for (const [, url] of css.matchAll(/url\(["']?([^"')]+\.woff2)["']?\)/g)) fonts.add(new URL(url!, href).href)
  }
  expect(fonts.size).toBe(expected)
  for (const url of fonts) {
    const res = await request.get(url)
    expect(res.status(), url).toBe(200)
    expect(res.headers()['content-type'], url).toBe('font/woff2')
  }
})

test('Hono 端点经 Next 的 catch-all 路由可达', async ({ request }) => {
  const res = await request.get('/api/health')
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ status: 'ok' })
})
