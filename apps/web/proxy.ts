import { requestRoot } from '@nextskin/api'
import { NextResponse, type NextRequest } from 'next/server'
import { getServer } from './lib/server'

// 进入 Hono 的路径自己会加这个头（Yggdrasil 的错误响应有意不加），这里跳过。必须与 app/api/[...path] 和
// next.config.ts 的 rewrite 范围完全一致：多跳过一个路径，那里的 Next 404 页就少了这个头（BS 每个响应都带）
const HONO_PATHS = [
  /^\/api\/.+/,
  /^\/[^/]+\.json$/,
  /^\/(?:csl|usm)(?:\/.*)?$/,
  /^\/(?:skin|cape)\/[^/]+\.png$/,
  /^\/textures\/[^/]+$/,
]

/**
 * 页面也带 X-Authlib-Injector-API-Location：玩家在启动器里填站点首页的地址，启动器据此找到 Yggdrasil API
 * （authlib-injector 的 API 地址指示，ADR-0001）。
 */
export async function proxy(request: NextRequest) {
  const response = NextResponse.next()
  const path = request.nextUrl.pathname
  if (HONO_PATHS.some((pattern) => pattern.test(path))) return response
  try {
    const { core } = await getServer()
    const settings = await core.settings.read(['yggdrasil.apiLocationIndication'])
    if (settings['yggdrasil.apiLocationIndication']) {
      response.headers.set('X-Authlib-Injector-API-Location', `${requestRoot(request)}/api/yggdrasil`)
    }
  } catch {
    // 数据库不可用时页面照常渲染，只是没有这个头；错误会在 API 请求里暴露
  }
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}
