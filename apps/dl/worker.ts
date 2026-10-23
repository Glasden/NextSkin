// dl.nextskin.org 的 Worker（ADR-0061）：只读出版本清单和各版本的 ZIP，别的键一律 404，桶里放了别的东西也不会被公开。
// 内容的可信由签名保证，不靠这里：清单的每个条目都签了名，ZIP 按签过名的 SHA-256 核对

/** 只用到的那部分 R2 绑定，免得为几个方法引入 @cloudflare/workers-types */
export interface ReleaseBucket {
  get(key: string): Promise<(ObjectHead & { body: ReadableStream }) | null>
  head(key: string): Promise<(ObjectHead & { body?: undefined }) | null>
}
interface ObjectHead {
  size: number
  httpEtag: string
}

export interface Env {
  RELEASES: ReleaseBucket
}

const MANIFEST = 'releases/v1.json'
const ARCHIVE = /^releases\/(\d+\.\d+\.\d+)\/nextskin-\1\.zip$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
    const key = new URL(request.url).pathname.slice(1)
    const manifest = key === MANIFEST
    if (!manifest && !ARCHIVE.test(key)) return new Response('Not Found', { status: 404 })
    const object = request.method === 'HEAD' ? await env.RELEASES.head(key) : await env.RELEASES.get(key)
    if (!object) return new Response('Not Found', { status: 404 })
    const headers = new Headers({
      'Content-Type': manifest ? 'application/json; charset=utf-8' : 'application/zip',
      'Content-Length': String(object.size),
      ETag: object.httpEtag,
      // 清单每次发布都会变，站点每天才读一次，几分钟的缓存够了；ZIP 一经上传不再改
      'Cache-Control': manifest ? 'public, max-age=300' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    return new Response(object.body ?? null, { headers })
  },
}
