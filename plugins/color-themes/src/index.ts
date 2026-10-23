import { definePlugin } from '@nextskin/plugin-sdk'

/** 更多配色：只声明数据，不需要能力（ADR-0057、ADR-0058 的参考插件）。 */
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
      {
        name: 'high-contrast',
        label: 'themes.highContrast',
        structure: { radius: 'square', borders: 'thick', cards: 'raised' },
        // 亮色下荧光色在白底上只有 1.16:1，只当色块（accent-fill），表面上的强调色用黑色；
        // 暗色下荧光色在黑底上看得清，accent 照旧用它（ADR-0058）。
        colors: {
          light: {
            bg: '#ffffff',
            surface: '#ffffff',
            'surface-raised': '#ffffff',
            'surface-sunken': '#f0f0f0',
            border: '#bdbdbd',
            'border-strong': '#000000',
            text: '#000000',
            'text-muted': '#4a4a4a',
            'text-inverse': '#ffffff',
            accent: '#000000',
            'accent-fg': '#ffffff',
            'accent-subtle': '#f0ffb0',
            'accent-fill': '#d4ff1e',
            'accent-fill-fg': '#000000',
            success: '#00813a',
            'success-fg': '#ffffff',
            warning: '#a85600',
            'warning-fg': '#ffffff',
            danger: '#d0021b',
            'danger-fg': '#ffffff',
            focus: '#0040ff',
            shadow: '#000000',
          },
          dark: {
            bg: '#000000',
            surface: '#0b0b0b',
            'surface-raised': '#161616',
            'surface-sunken': '#050505',
            border: '#3d3d3d',
            'border-strong': '#ffffff',
            text: '#ffffff',
            'text-muted': '#b5b5b5',
            'text-inverse': '#000000',
            accent: '#d4ff1e',
            'accent-fg': '#000000',
            'accent-subtle': '#37410f',
            success: '#3ddc84',
            'success-fg': '#000000',
            warning: '#ffb020',
            'warning-fg': '#000000',
            danger: '#ff4d5e',
            'danger-fg': '#000000',
            focus: '#d4ff1e',
            shadow: '#e6e6e6',
          },
        },
      },
    ],
  },
})
