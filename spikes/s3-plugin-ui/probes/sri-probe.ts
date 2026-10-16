/**
 * 不经过 Next，直接测三个浏览器引擎对"动态 import 的完整性校验"和"多个 import map"的支持。
 * 每个用例的模块执行时会把自己的名字记进 globalThis.__ran，服务端记录每个 URL 被请求了几次。
 *
 * 运行：node probes/sri-probe.ts      （WebKit 缺系统库时设 S3_WEBKIT，见 README）
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, firefox, webkit } from 'playwright'

const sri = (s: string) => `sha384-${createHash('sha384').update(s).digest('base64')}`
const body = (name: string) => `globalThis.__ran = (globalThis.__ran || []).concat(${JSON.stringify(name)}); export const name = ${JSON.stringify(name)}\n`
const WRONG = sri('something else')
const NONCE = 'probe-nonce'

/** 第一页：一个 import map；四种校验方式各一个正确和错误的用例 */
const sriPage = () => `<!doctype html><meta charset="utf-8">
<script type="importmap" nonce="${NONCE}">${JSON.stringify({
  imports: { dep: '/m/mapBadDep.js' },
  integrity: { '/m/mapGood.js': sri(body('mapGood')), '/m/mapBad.js': WRONG, '/m/mapBadDep.js': WRONG },
})}</script>
<script type="module" nonce="${NONCE}">
const out = {}
const settle = (el) => new Promise((r) => { el.onload = () => r('load'); el.onerror = () => r('error') })
const tryImport = (u) => import(u).then(() => 'executed', () => 'rejected')
async function preload(name, integrity) {
  const l = document.createElement('link'); l.rel = 'modulepreload'; l.href = '/m/' + name + '.js'; l.integrity = integrity
  const p = settle(l); document.head.append(l); return p
}
out.preloadGood = { event: await preload('preloadGood', ${JSON.stringify(sri(body('preloadGood')))}), import: await tryImport('/m/preloadGood.js') }
out.preloadBad = { event: await preload('preloadBad', ${JSON.stringify(WRONG)}), import: await tryImport('/m/preloadBad.js') }
{
  const s = document.createElement('script'); s.type = 'module'; s.src = '/m/scriptBad.js'; s.integrity = ${JSON.stringify(WRONG)}
  const p = settle(s); document.head.append(s); out.scriptBad = { event: await p, import: await tryImport('/m/scriptBad.js') }
}
out.mapGood = { import: await tryImport('/m/mapGood.js') }
out.mapBad = { import: await tryImport('/m/mapBad.js') }
out.mapBadStaticDep = { import: await tryImport('/m/mapBadParent.js') }
out.ran = globalThis.__ran
window.__result = out
</script>`

/** 第二页：已经加载过模块之后，再插入第二个 import map（带 nonce），看能否追加映射和 integrity */
const lateMapPage = () => `<!doctype html><meta charset="utf-8">
<script type="importmap" nonce="${NONCE}">${JSON.stringify({ imports: { early: '/m/early.js' } })}</script>
<script type="module" nonce="${NONCE}">
const out = {}
const tryImport = (u) => import(u).then(() => 'executed', () => 'rejected')
out.early = await tryImport('early')
const s = document.createElement('script'); s.type = 'importmap'; s.nonce = document.querySelector('script[nonce]').nonce
s.textContent = JSON.stringify({ imports: { late: '/m/lateMapped.js' }, integrity: { '/m/lateBad.js': ${JSON.stringify(WRONG)} } })
document.head.append(s)
out.lateMapping = await tryImport('late')
out.lateIntegrity = await tryImport('/m/lateBad.js')
out.ran = globalThis.__ran
window.__result = out
</script>`

let hits: Record<string, number> = {}
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const html = url.pathname === '/sri' ? sriPage() : url.pathname === '/late-map' ? lateMapPage() : null
  if (html !== null) {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    // 和宿主一样的 nonce + strict-dynamic
    res.setHeader('content-security-policy', `default-src 'self'; script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`)
    return void res.end(html)
  }
  const m = /^\/m\/(\w+)\.js$/.exec(url.pathname)
  if (m !== null) {
    const name = m[1]!
    hits[name] = (hits[name] ?? 0) + 1
    res.setHeader('content-type', 'text/javascript')
    res.setHeader('cache-control', 'no-store')
    return void res.end(name === 'mapBadParent' ? `import 'dep'\n${body(name)}` : body(name))
  }
  res.statusCode = 404
  res.end()
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await type.launch(name === 'webkit' && process.env.S3_WEBKIT ? { executablePath: process.env.S3_WEBKIT } : {})
  for (const pathname of ['/sri', '/late-map']) {
    hits = {}
    const page = await browser.newPage()
    const warnings: string[] = []
    page.on('console', (msg) => {
      if (/import ?map/i.test(msg.text())) warnings.push(msg.text().slice(0, 120))
    })
    await page.goto(origin + pathname)
    const result = await page.waitForFunction(() => (window as unknown as { __result?: unknown }).__result, null, { timeout: 15_000 }).then((h) => h.jsonValue())
    console.log(`${name} ${browser.version()} ${pathname}`)
    console.log(`  ${JSON.stringify(result)}`)
    console.log(`  请求次数 ${JSON.stringify(hits)}${warnings.length > 0 ? `\n  控制台 ${warnings.join(' | ')}` : ''}`)
    await page.close()
  }
  await browser.close()
}
server.close()
