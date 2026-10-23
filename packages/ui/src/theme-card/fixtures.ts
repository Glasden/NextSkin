import { DIAMOND, diamondStructure, resolveStructure, resolveTheme, themeCss } from '@nextskin/theme'

// ThemeCard、ThemePicker 的 story 用的几套主题：钴蓝、洋红、高对比取官方插件“更多配色”的值，余烬是连底色一起改的示例。
// 页面输出每套主题限定在 data-theme 上的 CSS，钻石青也输出：暗色页面里的亮色小样才不会跟着页面变暗
export const cobalt = 'color-themes/cobalt'
export const magenta = 'color-themes/magenta'
export const highContrast = 'color-themes/high-contrast'
export const ember = 'example/ember'
export const previewCss = [
  themeCss(DIAMOND, resolveTheme(), diamondStructure),
  themeCss(cobalt, resolveTheme({ light: { accent: '#2a52e5' }, dark: { accent: '#86a2ff' } }), diamondStructure),
  themeCss(
    magenta,
    resolveTheme({
      light: { accent: '#c2186b', danger: '#d73200' },
      dark: { accent: '#ff7ab8', danger: '#ff5023' },
    }),
    diamondStructure,
  ),
  themeCss(
    ember,
    resolveTheme({
      light: { accent: '#a5440f', bg: '#f5f2ef', 'surface-sunken': '#ece7e2', border: '#dcd5ce' },
      dark: { accent: '#ff9a5c', bg: '#12100e', surface: '#1a1714', 'surface-raised': '#24201c' },
    }),
    diamondStructure,
  ),
  // 高对比连结构一起改（ADR-0058）：亮色下荧光色只当色块，表面上的强调色是黑色
  themeCss(
    highContrast,
    resolveTheme({
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
    }),
    resolveStructure({ radius: 'square', borders: 'thick', cards: 'raised' }),
  ),
].join('')
