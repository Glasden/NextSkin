/** 插件路由的替身：正式实现里 /plugins/{id}/* 由 Hono 转发给 plugin host */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path } = await params
  return Response.json({ greeting: `来自 ${id} 的问候`, path: path.join('/') })
}
