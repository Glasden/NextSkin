import { getServer } from '../../../lib/server'

// 非页面的 HTTP 端点都由 Hono 处理（ADR-0003）。根路径上的协议端点经 next.config.ts 的 rewrite 进来，
// Route Handler 拿到的仍是改写前的 URL，所以 Hono 按公开路径注册路由
async function handle(request: Request) {
  const { app } = await getServer()
  return app.fetch(request)
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
