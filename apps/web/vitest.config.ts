import { defineProject } from 'vitest/config'

// 只跑页面层的纯函数测试；e2e/*.spec.ts 归 Playwright
export default defineProject({
  test: { name: 'web', include: ['{app,lib}/**/*.test.ts'] },
})
