import { storybookTest } from '@storybook/addon-vitest/vitest-plugin'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

// 组件在真实浏览器里测（Chromium）：单元测试一个项目，story 作为交互测试一个项目（ADR-0012）。
// browser 每次新建：Vitest 会改写 instances 里的对象，两个项目共用一份会重名。
const browser = () => ({
  enabled: true,
  headless: true,
  provider: playwright(),
  instances: [{ browser: 'chromium' as const }],
})

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'ui', include: ['src/**/*.test.{ts,tsx}'], browser: browser() } },
      {
        // 绝对路径：从仓库根目录运行 `pnpm test` 时 cwd 不是本包
        plugins: [storybookTest({ configDir: `${import.meta.dirname}/.storybook` })],
        test: { name: 'storybook', browser: browser() },
      },
    ],
  },
})
