import type { AppEnv } from '../env.ts'
import { createHash } from 'node:crypto'
import type { Core } from '@nextskin/domain'
import type { Hono } from 'hono'
import { publicCacheResponse, protocolMethodResponse, errorPage, httpDate } from './http.ts'

export function registerTextures(app: Hono<AppEnv>, core: Core): void {
  app.on('ALL', ['/textures/:hash', '/csl/textures/:hash', '/usm/textures/:hash'], async (c) => {
    if (c.req.param('hash').includes('/')) return errorPage(404)
    const methodResponse = protocolMethodResponse(c.req.method, 'GET')
    if (methodResponse) return methodResponse
    const file = await core.textures.readFile(c.req.param('hash'))
    const { 'cache.publicMaxAge': maxAge } = await core.settings.read(['cache.publicMaxAge'])
    if (!file) {
      const response = errorPage(404)
      response.headers.set('Cache-Control', `max-age=${maxAge}, no-cache, public`)
      return response
    }
    return publicCacheResponse(
      c.req.raw,
      new Response(Buffer.from(file.bytes), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(file.bytes.byteLength),
          'Last-Modified': httpDate(file.createdAt),
          ...(c.req.method === 'HEAD' ? {} : { ETag: `"${createHash('md5').update(file.bytes).digest('hex')}"` }),
        },
      }),
      maxAge,
    )
  })
}
