import { Hono } from 'hono'

/**
 * 所有非页面的 HTTP 端点。apps/web 用 catch-all Route Handler 把请求转进来（ADR-0003）。
 * handler 只做三件事：解析输入、调用领域用例、序列化结果（ADR-0004）。
 */
export function createApp() {
  return new Hono().get('/api/health', (c) => c.json({ status: 'ok' }))
}
