import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const port = 3100
const secret = 'nextskin-e2e-secret-0123456789abcdef'
// 每次运行一个新的数据目录，写入契约用例的固定数据（e2e/contract.spec.ts 经 Next 回放）。
// worker 进程会重新加载这个文件，所以目录名经环境变量传下去，不能各自再建一个
const dataDirectory = (process.env.NEXTSKIN_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'nextskin-e2e-')))

// 账号页（e2e/account.spec.ts）另起一个服务：站点地址要等于浏览器的 Origin。Better Auth 只接受站点自己的 Origin
// 发来的请求（两步验证、通行密钥），通行密钥也绑定在站点的域名上。回放契约用例的服务用的是录制环境的地址，做不到
const accountPort = 3101
const accountSite = `http://localhost:${accountPort}`
const accountDataDirectory = (process.env.NEXTSKIN_E2E_ACCOUNT_DATA_DIR ??= mkdtempSync(
  join(tmpdir(), 'nextskin-e2e-account-'),
))
const server = { NEXTSKIN_SECRET: secret, HOSTNAME: '127.0.0.1' }
// 后台的用例（e2e/admin.spec.ts）用 set-role 脚本设定超级管理员，要用同一个密钥打开 account 服务的数据目录
process.env.NEXTSKIN_E2E_SECRET = secret

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    // 页面发 multipart 请求或经过 Better Auth 的用例，要求站点地址等于浏览器的 Origin，跑在 account 服务上
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['account.spec.ts', 'skinlib.spec.ts', 'closet.spec.ts', 'admin.spec.ts'],
    },
    {
      name: 'account',
      use: { ...devices['Desktop Chrome'], baseURL: accountSite },
      testMatch: ['account.spec.ts', 'skinlib.spec.ts', 'closet.spec.ts', 'admin.spec.ts'],
    },
  ],
  // e2e 任务依赖 build（turbo.json），这里启动 standalone 产物；静态资源要按 Next 文档手动复制进去
  webServer: [
    {
      command: [
        `node ../../tests/contract/scripts/seed-sqlite.ts ${dataDirectory}`,
        'cp -r .next/static .next/standalone/apps/web/.next/',
        'node .next/standalone/apps/web/server.js',
      ].join(' && '),
      env: { ...server, PORT: String(port), NEXTSKIN_DATA_DIR: dataDirectory },
      url: `http://localhost:${port}`,
      // 回放依赖本次写入的数据和签名公钥，不能复用已经在运行的服务
      reuseExistingServer: false,
    },
    {
      command: [
        // 两个服务共用同一份 standalone 产物，静态资源由上面那个服务复制
        `node ../../tests/contract/scripts/seed-sqlite.ts ${accountDataDirectory} ${accountSite}`,
        'node .next/standalone/apps/web/server.js',
      ].join(' && '),
      env: { ...server, PORT: String(accountPort), NEXTSKIN_DATA_DIR: accountDataDirectory },
      url: accountSite,
      reuseExistingServer: false,
    },
  ],
})
