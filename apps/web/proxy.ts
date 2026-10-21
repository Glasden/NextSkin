import { allowedDuringMaintenance, requestRoot } from '@nextskin/api'
import type { Core } from '@nextskin/domain'
import { NextResponse, type NextRequest } from 'next/server'
import { getServer } from './lib/server'
import { siteIconHash } from './lib/site-icons'
import { siteImageUrl } from './lib/site-images'

// 进入 Hono 的路径自己会加这个头（Yggdrasil 的错误响应有意不加），这里跳过。必须与 app/api/[...path] 和
// next.config.ts 的 rewrite 范围完全一致：多跳过一个路径，那里的 Next 404 页就少了这个头（BS 每个响应都带）。
// 末尾的斜杠先去掉再比：rewrite 也认 /Alice.json/，否则维护期间它会被当成页面换成维护页
const HONO_PATHS = [
  /^\/api\/.+/,
  /^\/[^/]+\.json$/,
  /^\/(?:csl|usm)(?:\/.*)?$/,
  /^\/(?:skin|cape)\/[^/]+\.png$/,
  /^\/textures\/[^/]+$/,
  /^\/render(?:\/.*)?$/,
  /^\/site-images\/[^/]+$/,
  /^\/plugins\/[^/]+(?:\/.*)?$/,
]

// 授权页不许别的网站嵌进 iframe，防点击劫持（ADR-0037"页面"）；全站的 CSP 还没做，这里只给它们加
const NO_FRAME_PAGES = [/^\/device\/?$/, /^\/oauth\/(?:consent|error)\/?$/]

// 导入期间仍然能打开的页面：安装向导（从向导发起的导入在这里看进度）和维护页本身
const MAINTENANCE_PAGES = [/^\/setup(?:\/.*)?$/, /^\/maintenance$/]

/**
 * 两种维护模式下，不该打开的页面都换成维护页，地址不变，结束后刷新就回到原来的页面；Hono 的端点自己返回 503。
 * - 导入期间（ADR-0031）只放行安装向导和维护页，不读设置和会话。
 * - 手动维护（ADR-0044）按 @nextskin/api 的分类放行，其余页面只有管理员的会话能打开。
 * 页面也带 X-Authlib-Injector-API-Location：玩家在启动器里填站点首页的地址，启动器据此找到 Yggdrasil API
 * （authlib-injector 的 API 地址指示，ADR-0001）。手动维护时换成的维护页照样带，游戏服务可能照常
 */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname
  if (path === '/favicon.ico') return favicon(request)
  const trimmed = path.replace(/(?<=.)\/+$/, '')
  if (HONO_PATHS.some((pattern) => pattern.test(trimmed))) return NextResponse.next()
  let response = NextResponse.next()
  try {
    const { core, importer } = await getServer()
    if (importer.maintenance()) {
      return MAINTENANCE_PAGES.some((pattern) => pattern.test(path))
        ? noFrame(path, response)
        : NextResponse.rewrite(new URL('/maintenance', request.url))
    }
    const settings = await core.settings.read([
      'yggdrasil.apiLocationIndication',
      'maintenance.enabled',
      'maintenance.blockProtocols',
    ])
    const root = requestRoot(request)
    if (
      settings['maintenance.enabled'] &&
      !(await allowedPage(core, { path, headers: request.headers, root }, settings['maintenance.blockProtocols']))
    )
      response = NextResponse.rewrite(new URL('/maintenance', request.url))
    if (settings['yggdrasil.apiLocationIndication']) {
      response.headers.set('X-Authlib-Injector-API-Location', `${root}/api/yggdrasil`)
    }
  } catch {
    // 读不到设置（数据库不可用）时页面照常渲染，只是没有这个头：根布局也要读设置，页面自己会出错
  }
  return noFrame(path, response)
}

/** 手动维护期间这个页面能不能打开。已经知道维护开着，查会话出错就按挡住处理，不能因为一次查询失败把页面放给普通用户 */
async function allowedPage(
  core: Core,
  request: { path: string; headers: Headers; root: string },
  blockProtocols: boolean,
): Promise<boolean> {
  try {
    return await allowedDuringMaintenance(core, 'page', request, blockProtocols)
  } catch {
    return false
  }
}

/** 授权页不许嵌进 iframe；换成维护页时地址不变，照样加 */
function noFrame(path: string, response: NextResponse): NextResponse {
  if (NO_FRAME_PAGES.some((pattern) => pattern.test(path))) {
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  }
  return response
}

/**
 * 不看页面、直接取 /favicon.ico 的工具（RSS 阅读器、链接预览）也该看到站长的图标（ADR-0042）：上传了就 302 到那张 PNG，
 * 不缓存跳转，换图以后立即生效；没上传和读不到设置时交给 public/ 里的默认图标。维护期间照旧：
 * 导入不动这两个设置项，/site-images/ 也放行
 */
async function favicon(request: NextRequest) {
  try {
    const { core } = await getServer()
    const hash = siteIconHash(await core.settings.read(['site.favicon', 'site.logo']))
    if (hash) {
      // 同一个主机的跳转，Next 会把 Location 改成相对地址，不会露出自己的监听地址
      const redirect = NextResponse.redirect(new URL(siteImageUrl(hash), request.url), 302)
      redirect.headers.set('Cache-Control', 'no-cache')
      return redirect
    }
  } catch {
    // 数据库不可用时用默认图标
  }
  return NextResponse.next()
}

// 默认的 icon.svg、apple-icon.png 是 public/ 里的静态文件，不经过这里；/favicon.ico 要按设置跳转
export const config = {
  matcher: ['/((?!_next/static|_next/image|icon\\.svg|apple-icon\\.png).*)'],
}
