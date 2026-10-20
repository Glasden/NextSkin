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
// 安装向导（e2e/setup.spec.ts）要两个未初始化的站点：一个走“新站”，一个从 BS 导入。旧站是按 BS 表结构建的 SQLite 文件，
// 不需要 Docker（ADR-0031"测试"）
const setupNewPort = 3102
const setupImportPort = 3103
const setupNewDataDirectory = (process.env.NEXTSKIN_E2E_SETUP_NEW_DATA_DIR ??= mkdtempSync(
  join(tmpdir(), 'nextskin-e2e-setup-new-'),
))
const setupImportDataDirectory = (process.env.NEXTSKIN_E2E_SETUP_IMPORT_DATA_DIR ??= mkdtempSync(
  join(tmpdir(), 'nextskin-e2e-setup-import-'),
))
// 插件（e2e/plugins.spec.ts）也另起一个服务：启用邀请码之后注册都要填邀请码，会让共用站点的其他用例注册失败
const pluginsPort = 3104
const pluginsSite = `http://localhost:${pluginsPort}`
const pluginsDataDirectory = (process.env.NEXTSKIN_E2E_PLUGINS_DATA_DIR ??= mkdtempSync(
  join(tmpdir(), 'nextskin-e2e-plugins-'),
))
// 同样两个参考插件，打成插件包、换个 id 上传安装，在 plugin host 里运行（ADR-0033"验收：参考插件"）
const pluginsHostPort = 3105
const pluginsHostSite = `http://localhost:${pluginsHostPort}`
const pluginsHostDataDirectory = (process.env.NEXTSKIN_E2E_PLUGINS_HOST_DATA_DIR ??= mkdtempSync(
  join(tmpdir(), 'nextskin-e2e-plugins-host-'),
))
const oldSiteDirectory = (process.env.NEXTSKIN_E2E_OLD_SITE_DIR ??= mkdtempSync(join(tmpdir(), 'nextskin-e2e-bs-')))
const server = { NEXTSKIN_SECRET: secret, NEXTSKIN_HOST: '127.0.0.1' }
// e2e 任务依赖 pnpm build 组装出的发行目录（turbo.json），每个服务都经启动器启动（ADR-0039）
const start = 'node ../../dist/nextskin/nextskin.mjs start'
// 收尾时给启动器发 SIGTERM，走它按顺序停止的路径（先收任务、再关 HTTP）；启动器最多等核心 30 秒
const gracefulShutdown = { signal: 'SIGTERM', timeout: 40_000 } as const
// 后台和插件的用例（e2e/admin.spec.ts、plugins.spec.ts）用命令行 set-role 设定超级管理员，要用同一个密钥打开服务的数据目录
process.env.NEXTSKIN_E2E_SECRET = secret

export default defineConfig<{ pluginHost: boolean }>({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    // 页面发 multipart 请求或经过 Better Auth 的用例，要求站点地址等于浏览器的 Origin，跑在 account 服务上
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [
        'account.spec.ts',
        'skinlib.spec.ts',
        'closet.spec.ts',
        'admin.spec.ts',
        'setup.spec.ts',
        'plugins.spec.ts',
        'external-login.spec.ts',
        'connect.spec.ts',
        'captcha.spec.ts',
      ],
    },
    {
      name: 'account',
      use: { ...devices['Desktop Chrome'], baseURL: accountSite },
      testMatch: ['account.spec.ts', 'skinlib.spec.ts', 'closet.spec.ts', 'admin.spec.ts', 'connect.spec.ts'],
    },
    {
      name: 'plugins',
      workers: 1,
      use: { ...devices['Desktop Chrome'], baseURL: pluginsSite },
      // 验证码（captcha.spec.ts）启用后登录和注册都要过挂件，同样不能和别的用例并行
      testMatch: ['plugins.spec.ts', 'external-login.spec.ts', 'captcha.spec.ts'],
    },
    {
      name: 'plugins-host',
      workers: 1,
      use: { ...devices['Desktop Chrome'], baseURL: pluginsHostSite, pluginHost: true },
      testMatch: ['plugins.spec.ts', 'external-login.spec.ts'],
    },
    // 每个用例自己指定站点（两个未初始化的服务），用例之间不共享状态
    { name: 'setup', use: { ...devices['Desktop Chrome'] }, testMatch: ['setup.spec.ts'] },
  ],
  webServer: [
    {
      command: [`node ../../tests/contract/scripts/seed-sqlite.ts ${dataDirectory}`, start].join(' && '),
      env: { ...server, NEXTSKIN_PORT: String(port), NEXTSKIN_DATA_DIR: dataDirectory },
      url: `http://localhost:${port}`,
      // 回放依赖本次写入的数据和签名公钥，不能复用已经在运行的服务
      reuseExistingServer: false,
      gracefulShutdown,
    },
    {
      command: [`node ../../tests/contract/scripts/seed-sqlite.ts ${accountDataDirectory} ${accountSite}`, start].join(
        ' && ',
      ),
      env: { ...server, NEXTSKIN_PORT: String(accountPort), NEXTSKIN_DATA_DIR: accountDataDirectory },
      url: accountSite,
      reuseExistingServer: false,
      gracefulShutdown,
    },
    {
      command: [`node ../../tests/contract/scripts/seed-sqlite.ts ${pluginsDataDirectory} ${pluginsSite}`, start].join(
        ' && ',
      ),
      env: { ...server, NEXTSKIN_PORT: String(pluginsPort), NEXTSKIN_DATA_DIR: pluginsDataDirectory },
      url: pluginsSite,
      reuseExistingServer: false,
      gracefulShutdown,
    },
    {
      command: [
        `node ../../tests/contract/scripts/seed-sqlite.ts ${pluginsHostDataDirectory} ${pluginsHostSite}`,
        start,
      ].join(' && '),
      env: { ...server, NEXTSKIN_PORT: String(pluginsHostPort), NEXTSKIN_DATA_DIR: pluginsHostDataDirectory },
      url: pluginsHostSite,
      reuseExistingServer: false,
      gracefulShutdown,
    },
    {
      // 不写任何数据：站点未初始化，启动时生成安装码
      command: start,
      env: { ...server, NEXTSKIN_PORT: String(setupNewPort), NEXTSKIN_DATA_DIR: setupNewDataDirectory },
      url: `http://localhost:${setupNewPort}/api/health`,
      reuseExistingServer: false,
      gracefulShutdown,
    },
    {
      command: [`node ../../packages/importer/scripts/bs-sqlite-site.ts ${oldSiteDirectory}`, start].join(' && '),
      env: { ...server, NEXTSKIN_PORT: String(setupImportPort), NEXTSKIN_DATA_DIR: setupImportDataDirectory },
      url: `http://localhost:${setupImportPort}/api/health`,
      reuseExistingServer: false,
      gracefulShutdown,
    },
  ],
})
