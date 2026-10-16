import { createApp } from '@nextskin/api'

// 非页面的 HTTP 端点都由 Hono 处理（ADR-0003）
const app = createApp()

function handle(request: Request) {
  return app.fetch(request)
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT }
