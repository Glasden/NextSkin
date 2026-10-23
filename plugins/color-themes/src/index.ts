import { definePlugin } from '@nextskin/plugin-sdk'

/** 更多配色：只声明数据，不需要能力（ADR-0057 的参考插件）。 */
export default definePlugin({
  capabilities: [],
  ui: {
    themes: [
      {
        name: 'cobalt',
        label: 'themes.cobalt',
        colors: { light: { accent: '#2a52e5' }, dark: { accent: '#86a2ff' } },
      },
      {
        name: 'magenta',
        label: 'themes.magenta',
        // 危险色移向朱红，和洋红的强调色拉开；警告色不动，和朱红仍分得开（DESIGN.md 附录）
        colors: {
          light: { accent: '#c2186b', danger: '#d73200' },
          dark: { accent: '#ff7ab8', danger: '#ff5023' },
        },
      },
    ],
  },
})
