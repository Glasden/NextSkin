import type { Core } from '@nextskin/domain'
import type { Hono } from 'hono'
import type { AppEnv } from './env.ts'
import { errorPage, protocolMethodResponse } from './protocol/http.ts'

/**
 * 站点图片的公开地址（ADR-0042）：文件在存储里就返回，不查设置，刚上传、还没保存的图要能在表单里预览。
 * 地址里带像素 hash，换了图就是新地址，可以长期缓存
 */
export function registerSiteImages(app: Hono<AppEnv>, core: Core): void {
  app.on('ALL', '/site-images/:file', async (c) => {
    // 新端点的 OPTIONS 也返回 405，同出图端点
    const method = protocolMethodResponse(c.req.method === 'OPTIONS' ? 'POST' : c.req.method, 'GET')
    if (method) return method
    const bytes = await core.siteImages.read(c.req.param('file'))
    if (!bytes) return errorPage(404)
    return new Response(c.req.method === 'HEAD' ? null : Buffer.from(bytes), {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })
}
