import { defineConfig, devices } from '@playwright/test'

const mode = process.env.S3_MODE ?? 'adhoc'

export default defineConfig({
  testDir: 'tests',
  // 测试会改 data/plugins/active.json 模拟插件换代，必须串行
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: `data/results/${mode}.json` }]],
  use: { baseURL: process.env.S3_BASE_URL ?? 'http://localhost:3300' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        // 本机缺 WebKit 的几个系统库时，可以指向一个补了 LD_LIBRARY_PATH 的 pw_run.sh（见 README）
        launchOptions: process.env.S3_WEBKIT ? { executablePath: process.env.S3_WEBKIT } : {},
      },
    },
  ],
})
