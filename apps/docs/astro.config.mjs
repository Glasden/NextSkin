import { readFileSync } from 'node:fs'
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

// 上线后改成实际域名；也可以由构建环境注入 SITE_URL。
const site = process.env.SITE_URL ?? 'https://docs.nextskin.org'

// sync 脚本写下的版本信息。还没跑过 sync 时不带徽章，避免拿到过期的版本号。
let sdkVersion
try {
  sdkVersion = JSON.parse(
    readFileSync(new URL('./src/data/sdk-meta.json', import.meta.url), 'utf8'),
  ).version
} catch {
  sdkVersion = undefined
}

export default defineConfig({
  site,
  integrations: [
    starlight({
      title: 'NextSkin',
      description: 'Minecraft 皮肤托管与外置登录站点 NextSkin 的部署、使用和插件开发文档。',
      logo: {
        light: './src/assets/logo.svg',
        dark: './src/assets/logo-dark.svg',
        alt: 'NextSkin',
      },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/theme.css'],
      components: {
        // 页脚在默认的翻页链接下面补一行版本信息
        Footer: './src/components/Footer.astro',
      },
      defaultLocale: 'zh-CN',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
      },
      pagefind: true,
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/Glasden/NextSkin',
        },
      ],
      sidebar: [
        {
          label: '服主指南',
          items: [
            { label: '概览', link: '/guide/' },
            { label: '安装部署', link: '/guide/install/' },
            { label: '命令行', link: '/guide/commands/' },
            { label: '常见问题', link: '/guide/faq/' },
          ],
        },
        {
          label: '玩家指南',
          items: [
            { label: '概览', link: '/players/' },
            { label: '在游戏里用', link: '/players/client/' },
          ],
        },
        { label: '开发', items: [{ label: '本地开发', link: '/development/' }] },
        { label: '插件开发', items: [{ label: '总览', link: '/plugins/' }] },
        {
          // 版本号只挂在分组上；单篇有差异时由 sync 脚本给那篇加徽章。
          label: '插件 API 参考',
          ...(sdkVersion ? { badge: { text: `v${sdkVersion}`, variant: 'note' } } : {}),
          items: [{ autogenerate: { directory: 'plugins/reference' } }],
        },
      ],
    }),
  ],
})
