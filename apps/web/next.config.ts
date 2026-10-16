import type { NextConfig } from 'next'

const root = new URL('../..', import.meta.url).pathname

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  // 材质和用户上传的图片不经过 next/image，Image Optimization 保持关闭（不变量 8、ADR-0003）
  images: { unoptimized: true },
  // 类型检查由 typecheck 任务用 TypeScript 7 负责（ADR-0014）
  typescript: { ignoreBuildErrors: true },
  // 不让 next dev 在项目目录生成 AGENTS.md
  agentRules: false,
}

export default config
