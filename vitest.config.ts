import { defineConfig } from 'vitest/config'

// 根目录的 `pnpm test [路径]` 用它一次跑所有包的单元测试；`pnpm check` 走 turbo，在各包里分别跑。
export default defineConfig({
  test: {
    projects: [
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      'plugins/*/vitest.config.ts',
      'tests/contract/vitest.config.ts',
    ],
  },
})
