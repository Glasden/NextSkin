import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

// 不用 URL 的 pathname：Windows 上会得到 /D:/… 这种无效路径
const root = fileURLToPath(new URL('../..', import.meta.url))

// 根路径上的协议端点转给 Hono（ADR-0003）。Route Handler 拿到的仍是改写前的 URL，所以目标只要落进
// app/api/[...path] 即可。用 afterFiles：public 目录里的同名文件优先，与 BS 的 nginx try_files 相同。
// 改了这里要同步 e2e/protocol.spec.ts 和 proxy.ts 的 HONO_PATHS
const protocolRewrites = [
  '/:player.json',
  '/csl/:path*',
  '/usm/:path*',
  '/skin/:player.png',
  '/cape/:player.png',
  '/textures/:hash',
  '/render/:path*',
  // 站点图片（ADR-0042）
  '/site-images/:file',
  // 插件的路由（ADR-0033）
  '/plugins/:id/:path*',
]

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: root,
  // plugin host 是单独的 Node 进程，入口不在任何模块的 import 里，追踪不到（ADR-0033、lib/server.ts）
  outputFileTracingIncludes: { '/*': ['../../packages/plugin-host/dist/host.mjs'] },
  turbopack: { root },
  poweredByHeader: false,
  // 材质和用户上传的图片不经过 next/image，Image Optimization 保持关闭（不变量 8、ADR-0003）
  images: { unoptimized: true },
  // 类型检查由 typecheck 任务用 TypeScript 7 负责（ADR-0014）
  typescript: { ignoreBuildErrors: true },
  experimental: {
    // typegen 生成严格的路由校验：默认版把页面的 props 当成 any，params 不写成 Promise 或参数名写错都不报错
    strictRouteTypes: true,
    // next dev 的 MCP 服务会把浏览器的控制台日志写进 .next/dev/logs/next-development.log，这次写入让 Turbopack
    // 发 restart、页面整页重载，重载又打出新的日志，dev 页面每秒重载好几次。我们不用它，关掉
    mcpServer: false,
  },
  // 不让 next dev 在项目目录生成 AGENTS.md
  agentRules: false,
  // next dev 只放行 localhost 来源的开发资源请求：用 127.0.0.1 打开页面时客户端脚本和 HMR 被挡，页面不水合
  allowedDevOrigins: ['127.0.0.1'],
  // 不把 /api/yggdrasil/ 308 跳转到不带斜杠的地址：authlib-injector 请求元数据时带斜杠，BS 直接返回 200，
  // 而旧版 Java 的 HttpURLConnection 不跟随 308。Hono 用 strict: false 匹配带斜杠的路径
  skipTrailingSlashRedirect: true,
  // BS 的认证页地址：旧站的书签、论坛帖子里的注册链接还能用
  redirects: () =>
    Promise.resolve([
      { source: '/auth/login', destination: '/sign-in', permanent: true },
      { source: '/auth/register', destination: '/sign-up', permanent: true },
      { source: '/auth/forgot', destination: '/forgot-password', permanent: true },
      // BS 的材质详情页（ADR-0001 的例子）
      { source: '/skinlib/show/:tid', destination: '/skinlib/:tid', permanent: true },
    ]),
  rewrites: () =>
    Promise.resolve({
      beforeFiles: [],
      afterFiles: protocolRewrites.map((source) => ({ source, destination: '/api/protocol' })),
      fallback: [],
    }),
}

// 语言解析和消息在 i18n/request.ts（ADR-0019）
export default createNextIntlPlugin('./i18n/request.ts')(config)
