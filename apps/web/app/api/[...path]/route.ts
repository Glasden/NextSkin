import { getServer } from '../../../lib/server'
import { peerAddress } from '../../../lib/peer-address'

// 非页面的 HTTP 端点都由 Hono 处理（ADR-0003）。根路径上的协议端点经 next.config.ts 的 rewrite 进来，
// Route Handler 拿到的仍是改写前的 URL，所以 Hono 按公开路径注册路由
async function handle(request: Request) {
  const { app } = await getServer()
  // Next 传进来的 Request 是 Proxy，过不了 Node 的 Request 构造器的品牌检查。没有 Content-Length 的请求
  // （没有请求体的 DELETE、分块传输的 POST）经过 Hono 的 bodyLimit 时，它要 new Request(request, …) 包一层
  // 请求体，会抛 TypeError。这里先换成普通的 Request；Node 的流式请求体要带 duplex
  const init = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    duplex: 'half' as const,
  }
  return app.fetch(new Request(request.url, init), { peer: peerAddress(request.headers) })
}

export {
  handle as DELETE,
  handle as GET,
  handle as HEAD,
  handle as OPTIONS,
  handle as PATCH,
  handle as POST,
  handle as PUT,
}
