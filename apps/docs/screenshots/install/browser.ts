import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { CDP_PORT, cache } from './common.ts'

// 部署文档截图用的常驻浏览器（见同目录 README）：无头 Chromium，像素密度 1，正文用 Noto Sans CJK SC。
// 前台运行，Ctrl+C 关掉；登录状态留在 .cache/profile 里。shoot.ts、annotate.ts 经 CDP 连上来。
// NEXTSKIN_SHOTS_MAP="skin.example.com 10.88.0.206"：文档里的示例域名解析到正在测的容器

// 和组件截图共用下载好的字体（packages/ui 的 test:visual）
const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const fonts = join(repository, 'packages/ui/node_modules/.cache/visual-fonts')
execFileSync(process.execPath, [join(repository, 'packages/ui/visual/fonts.ts'), fonts], { stdio: 'inherit' })

// 系统里的文泉驿、Unifont 带点阵字形，面板的中文会被它们渲染得发虚；面板常写的几个字体名都换成 Noto Sans CJK SC
const families = ['sans-serif', 'system-ui', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB']
mkdirSync(cache, { recursive: true })
const fontsConf = join(cache, 'fonts.conf')
writeFileSync(
  fontsConf,
  [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
    '<fontconfig>',
    '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>',
    `  <dir>${fonts}</dir>`,
    `  <cachedir>${join(cache, 'fontconfig')}</cachedir>`,
    '  <selectfont><rejectfont><glob>/usr/share/fonts/truetype/wqy/*</glob><glob>/usr/share/fonts/*/unifont/*</glob></rejectfont></selectfont>',
    ...families.map(
      (family) =>
        `  <alias binding="strong"><family>${family}</family><prefer><family>Noto Sans CJK SC</family></prefer></alias>`,
    ),
    '</fontconfig>',
    '',
  ].join('\n'),
)
process.env.FONTCONFIG_FILE = fontsConf

// 经代理访问容器的内网地址会 502
for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'])
  delete process.env[key]

const map = process.env.NEXTSKIN_SHOTS_MAP
const context = await chromium.launchPersistentContext(join(cache, 'profile'), {
  headless: true,
  viewport: null,
  locale: 'zh-CN',
  // 测试环境的 HTTPS 用自签证书
  ignoreHTTPSErrors: true,
  args: [
    `--remote-debugging-port=${CDP_PORT}`,
    '--force-device-scale-factor=1',
    '--window-size=1440,900',
    '--lang=zh-CN',
    '--no-proxy-server',
    '--hide-scrollbars',
    ...(map ? [`--host-resolver-rules=MAP ${map}`] : []),
  ],
})
if (context.pages().length === 0) await context.newPage()
console.log(`浏览器已就绪，CDP 端口 ${CDP_PORT}${map ? `，${map}` : ''}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void context.close().finally(() => process.exit(0))
  })
