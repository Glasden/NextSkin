import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

// 组件截图回归（DESIGN.md §12）。浏览器跑在与 @playwright/test 同版本的官方镜像里，系统字体和渲染都与宿主机无关，
// 本地和 CI 才能共用一套基线。测试进程留在宿主机，exposeNetwork 让容器里的浏览器访问本机的 Storybook。
// 基线文件名不带平台后缀：截图都出自同一个镜像
const { version } = createRequire(import.meta.url)('@playwright/test/package.json') as { version: string }
const storybookPort = 6007
const browserPort = 6008
const container = 'nextskin-visual-browser'
// 挂进容器的中文字体，见 visual/fonts.ts
const fontsDir = fileURLToPath(new URL('node_modules/.cache/visual-fonts', import.meta.url))

export default defineConfig({
  testDir: 'visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${storybookPort}`,
    connectOptions: { wsEndpoint: `ws://127.0.0.1:${browserPort}/`, exposeNetwork: '<loopback>' },
  },
  webServer: [
    {
      // storybook-static 由 turbo 的 storybook:build 任务先构建
      command: `vite preview --outDir storybook-static --port ${storybookPort} --strictPort`,
      port: storybookPort,
      reuseExistingServer: false,
    },
    {
      // 上次异常退出时容器可能还在，先删掉；第一次运行要拉取镜像和字体
      command: [
        `node visual/fonts.ts '${fontsDir}' &&`,
        `{ docker rm -f ${container} >/dev/null 2>&1; true; } &&`,
        `docker run --rm --init --name ${container} -p 127.0.0.1:${browserPort}:${browserPort}`,
        `-v '${fontsDir}:/usr/share/fonts/nextskin-visual:ro'`,
        `--user pwuser --workdir /home/pwuser mcr.microsoft.com/playwright:v${version}-noble`,
        `npx -y playwright@${version} run-server --port ${browserPort} --host 0.0.0.0`,
      ].join(' '),
      // 不能只等端口：Docker 一启动容器就占住端口，里面的服务还没起来。服务就绪后 HTTP 请求返回 200
      url: `http://127.0.0.1:${browserPort}/`,
      timeout: 600_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
  ],
})
