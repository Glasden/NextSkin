import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const root = new URL('../..', import.meta.url).pathname

// 根路径上的协议端点转给 Hono（ADR-0003）。Route Handler 拿到的仍是改写前的 URL，所以目标只要落进
// app/api/[...path] 即可。用 afterFiles：public 目录里的同名文件优先，与 BS 的 nginx try_files 相同。
// 改了这里要同步 e2e/protocol.spec.ts
const protocolRewrites = [
  '/:player.json',
  '/csl/:path*',
  '/usm/:path*',
  '/skin/:player.png',
  '/cape/:player.png',
  '/textures/:hash',
]

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  // 材质和用户上传的图片不经过 next/image，Image Optimization 保持关闭（不变量 8、ADR-0003）
  images: { unoptimized: true },
  // 类型检查由 typecheck 任务用 TypeScript 7 负责（ADR-0014）
  typescript: { ignoreBuildErrors: true },
  // typegen 生成严格的路由校验：默认版把页面的 props 当成 any，params 不写成 Promise 或参数名写错都不报错
  experimental: { strictRouteTypes: true },
  // 不让 next dev 在项目目录生成 AGENTS.md
  agentRules: false,
  // 不把 /api/yggdrasil/ 308 跳转到不带斜杠的地址：authlib-injector 请求元数据时带斜杠，BS 直接返回 200，
  // 而旧版 Java 的 HttpURLConnection 不跟随 308。Hono 用 strict: false 匹配带斜杠的路径
  skipTrailingSlashRedirect: true,
  rewrites: () =>
    Promise.resolve({
      beforeFiles: [],
      afterFiles: protocolRewrites.map((source) => ({ source, destination: '/api/protocol' })),
      fallback: [],
    }),
}

// 语言解析和消息在 i18n/request.ts（ADR-0019）
export default createNextIntlPlugin('./i18n/request.ts')(config)
