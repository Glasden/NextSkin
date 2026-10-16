import { defineConfig, devices } from '@playwright/test'

const port = 3100

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // e2e 任务依赖 build（turbo.json），这里启动 standalone 产物；静态资源要按 Next 文档手动复制进去
  webServer: {
    command: 'cp -r .next/static .next/standalone/apps/web/.next/ && node .next/standalone/apps/web/server.js',
    env: { PORT: String(port), HOSTNAME: '127.0.0.1' },
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
  },
})
