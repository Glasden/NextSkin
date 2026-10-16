import type { NextConfig } from 'next'

const root = import.meta.dirname

const config: NextConfig = {
  images: { unoptimized: true },
  // 类型检查用 TypeScript 7 单独跑（npm run check）；Next 16.4 的内置检查依赖 TS 5 的 JS API
  typescript: { ignoreBuildErrors: true },
  turbopack: { root },
  outputFileTracingRoot: root,
  // 不让 next dev 在 spike 目录里生成 AGENTS.md
  agentRules: false,
}

export default config
