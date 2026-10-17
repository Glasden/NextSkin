import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const port = 3100
const secret = 'nextskin-e2e-secret-0123456789abcdef'
// 每次运行一个新的数据目录，写入契约用例的固定数据（e2e/contract.spec.ts 经 Next 回放）。
// worker 进程会重新加载这个文件，所以目录名经环境变量传下去，不能各自再建一个
const dataDirectory = (process.env.NEXTSKIN_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'nextskin-e2e-')))

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // e2e 任务依赖 build（turbo.json），这里启动 standalone 产物；静态资源要按 Next 文档手动复制进去
  webServer: {
    command: [
      `node ../../tests/contract/scripts/seed-sqlite.ts ${dataDirectory}`,
      'cp -r .next/static .next/standalone/apps/web/.next/',
      'node .next/standalone/apps/web/server.js',
    ].join(' && '),
    env: {
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NEXTSKIN_DATA_DIR: dataDirectory,
      NEXTSKIN_SECRET: secret,
    },
    url: `http://localhost:${port}`,
    // 回放依赖本次写入的数据和签名公钥，不能复用已经在运行的服务
    reuseExistingServer: false,
  },
})
