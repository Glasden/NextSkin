/**
 * 另一个源（127.0.0.1:3301）：CSP 探测用。记录收到的每个请求，测试通过 /log 读取，判断请求有没有离开浏览器。
 * 运行：node scripts/xorigin-server.ts
 */
import { createServer } from 'node:http'

const PORT = 3301
const log: string[] = []
const js = (flag: string) => `globalThis.${flag} = true\n`
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  res.setHeader('access-control-allow-origin', '*')
  if (url.pathname === '/log') return void res.end(JSON.stringify(log))
  if (url.pathname === '/reset') return void (log.length = 0, res.end('ok'))
  log.push(url.pathname)
  const scripts: Record<string, string> = {
    '/static.js': js('__s3_static'),
    '/dynamic.js': js('__s3_dynamic'),
    '/inject.js': js('__s3_inject'),
    '/inject-nonce.js': js('__s3_inject_nonce'),
  }
  const script = scripts[url.pathname]
  if (script !== undefined) {
    res.setHeader('content-type', 'text/javascript')
    return void res.end(script)
  }
  if (url.pathname === '/fetch') return void res.end('{}')
  if (url.pathname === '/img.gif') {
    res.setHeader('content-type', 'image/gif')
    return void res.end(GIF)
  }
  res.statusCode = 404
  res.end()
}).listen(PORT, '127.0.0.1', () => console.log(`xorigin on http://127.0.0.1:${PORT}`))
