import type { Core } from '@nextskin/domain'
import type { Hono } from 'hono'
import type { AppEnv } from './env.ts'
import { errorPage, protocolMethodResponse } from './protocol/http.ts'

/** 广告联盟在根路径读取的文件；手动维护期间照常提供（ADR-0063）。 */
export function registerAdsTxt(app: Hono<AppEnv>, core: Core): void {
  app.on('ALL', '/ads.txt', async (c) => {
    const method = protocolMethodResponse(c.req.method === 'OPTIONS' ? 'POST' : c.req.method, 'GET')
    if (method) return method
    const content = (await core.settings.read(['custom.adsTxt']))['custom.adsTxt']
    if (!content.trim()) return errorPage(404)
    return new Response(c.req.method === 'HEAD' ? null : content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })
}
