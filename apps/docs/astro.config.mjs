import { readFileSync } from 'node:fs'
import starlight from '@astrojs/starlight'
import { defineConfig, passthroughImageService } from 'astro/config'

// scripts/sync.ts 写下的版本信息；dev、build 和 typegen 都先跑它
const { sdk } = JSON.parse(readFileSync(new URL('./src/data/versions.json', import.meta.url), 'utf8'))

export default defineConfig({
  site: 'https://docs.nextskin.org',
  // 图片原样发布，不装 sharp（见 pnpm-workspace.yaml 的 overrides）
  image: { service: passthroughImageService() },
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
      // 像素字体的分片随站点发布，和页面同源（ADR-0054）
      customCss: ['@nextskin/ui/fonts.css', './src/styles/theme.css'],
      components: {
        // 页脚在默认的翻页链接下面补一行版本信息
        Footer: './src/components/Footer.astro',
      },
      editLink: { baseUrl: 'https://github.com/Glasden/NextSkin/edit/main/apps/docs/' },
      defaultLocale: 'root',
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
            {
              label: '安装部署',
              items: [
                { label: '选择安装方式', link: '/guide/install/' },
                { label: '宝塔面板', link: '/guide/install/baota/' },
                { label: '1Panel', link: '/guide/install/1panel/' },
                { label: 'Docker', link: '/guide/install/docker/' },
                { label: 'systemd', link: '/guide/install/systemd/' },
                { label: 'Windows', link: '/guide/install/windows/' },
                { label: '反向代理与 HTTPS', link: '/guide/install/reverse-proxy/' },
                { label: '配置与进程', link: '/guide/install/configuration/' },
              ],
            },
            { label: '升级与回退', link: '/guide/upgrade/' },
            { label: '自定义代码', link: '/guide/custom-code/' },
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
          // 版本号只挂在分组上；单篇有差异时由 scripts/sync.ts 给那篇加徽章。
          label: '插件 API 参考',
          badge: { text: `v${sdk}`, variant: 'note' },
          items: [{ autogenerate: { directory: 'plugins/reference' } }],
        },
      ],
    }),
  ],
})
