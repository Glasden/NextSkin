import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

/**
 * 插件静态资源与 shim。正式实现里由 Hono 提供（ADR-0003），这里用 Route Handler 代替。
 *   /plugins-assets/_shared/{file}            → data/shims/{file}
 *   /plugins-assets/{id}/{version}/{file}     → data/plugins/{id}/{version}/{file}
 */
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/
const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const dataDir = path.join(process.cwd(), 'data')

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const segments = (await params).path
  const shared = segments[0] === '_shared'
  const checked = shared ? segments.slice(1) : segments
  if (!checked.every((s) => SEGMENT.test(s) && !s.includes('..'))) return new Response('bad path', { status: 400 })
  const file =
    shared && segments.length === 2
      ? path.join(dataDir, 'shims', segments[1]!)
      : segments.length === 3
        ? path.join(dataDir, 'plugins', ...segments)
        : null
  const type = file === null ? undefined : TYPES[path.extname(file)]
  if (file === null || type === undefined) return new Response('not found', { status: 404 })
  try {
    // 字符串校验挡得住 ..，挡不住符号链接：解析出真实路径后再确认仍在 data/ 里
    const real = await realpath(file)
    const relative = path.relative(await realpath(dataDir), real)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('not found', { status: 404 })
    const body = await readFile(real)
    return new Response(body, {
      headers: {
        'content-type': type,
        // 路径里带版本号或内容 hash，可以永久缓存
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      },
    })
  } catch {
    return new Response('not found', { status: 404 })
  }
}
