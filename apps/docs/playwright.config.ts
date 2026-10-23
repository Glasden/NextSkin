import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const directories: string[] = []
function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}
// webServer 已停止后，只清理本进程新建的目录；worker 继承的或用户指定的目录保留。
process.on('exit', () => {
  for (const directory of directories) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // 清理失败不影响测试退出码。
    }
  }
})

// 插槽一览的截图（pnpm docs:screenshots，ADR-0060）。服务从 pnpm build 组装的发行目录经启动器启动，启动前写入契约用例的
// 固定数据（同 e2e）和 screenshots/site.ts 里的站点设置。浏览器跑在组件截图（packages/ui 的 test:visual）同一个镜像里，
// 挂同样的中文字体，谁来跑截出来都一样。
// 不做像素比较：screenshots/slots.spec.ts 把图和清单写进 src/assets/slots，看过再提交
const { version } = createRequire(import.meta.url)('@playwright/test/package.json') as { version: string }
const port = 3110
const site = `http://localhost:${port}`
const browserPort = 6018
const container = 'nextskin-docs-browser'
const secret = 'nextskin-docs-screenshots-0123456789abcdef'
// worker 进程会重新加载这个文件，目录名经环境变量传下去，不能各自再建一个
const dataDirectory = (process.env.NEXTSKIN_SCREENSHOTS_DATA_DIR ??= temporaryDirectory('nextskin-docs-'))
// 截图脚本用命令行设身份、装插件，要用同一个密钥打开服务的数据目录
process.env.NEXTSKIN_SCREENSHOTS_SECRET = secret
// 和组件截图共用下载好的字体
const fontsDir = fileURLToPath(new URL('../../packages/ui/node_modules/.cache/visual-fonts', import.meta.url))

export default defineConfig({
  testDir: 'screenshots',
  forbidOnly: !!process.env.CI,
  workers: 1,
  reporter: 'list',
  timeout: 300_000,
  use: {
    baseURL: site,
    connectOptions: { wsEndpoint: `ws://127.0.0.1:${browserPort}/`, exposeNetwork: '<loopback>' },
  },
  webServer: [
    {
      command: [
        `node ../../tests/contract/scripts/seed-sqlite.ts ${dataDirectory} ${site}`,
        `node screenshots/site.ts ${dataDirectory}`,
        'node ../../dist/nextskin/nextskin.mjs start',
      ].join(' && '),
      env: {
        NEXTSKIN_SECRET: secret,
        NEXTSKIN_HOST: '127.0.0.1',
        NEXTSKIN_PORT: String(port),
        NEXTSKIN_DATA_DIR: dataDirectory,
      },
      url: site,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 40_000 },
    },
    {
      // 同 packages/ui/playwright.config.ts：上次异常退出时容器可能还在，先删掉
      command: [
        `node ../../packages/ui/visual/fonts.ts '${fontsDir}' &&`,
        `{ docker rm -f ${container} >/dev/null 2>&1; true; } &&`,
        `docker run --rm --init --name ${container} -p 127.0.0.1:${browserPort}:${browserPort}`,
        `-v '${fontsDir}:/usr/share/fonts/nextskin-visual:ro'`,
        `--user pwuser --workdir /home/pwuser mcr.microsoft.com/playwright:v${version}-noble`,
        `npx -y playwright@${version} run-server --port ${browserPort} --host 0.0.0.0`,
      ].join(' '),
      url: `http://127.0.0.1:${browserPort}/`,
      timeout: 600_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
  ],
})
