import { DIAMOND, resolveTheme, themeCss } from '@nextskin/theme'

// ThemeCard、ThemePicker 的 story 用的几套主题：钴蓝、洋红取官方插件“更多配色”的值，余烬是连底色一起改的示例。
// 页面输出每套主题限定在 data-theme 上的 CSS，钻石青也输出：暗色页面里的亮色小样才不会跟着页面变暗
export const cobalt = 'color-themes/cobalt'
export const magenta = 'color-themes/magenta'
export const ember = 'example/ember'
export const previewCss = [
  themeCss(DIAMOND, resolveTheme()),
  themeCss(cobalt, resolveTheme({ light: { accent: '#2a52e5' }, dark: { accent: '#86a2ff' } })),
  themeCss(
    magenta,
    resolveTheme({
      light: { accent: '#c2186b', danger: '#d73200' },
      dark: { accent: '#ff7ab8', danger: '#ff5023' },
    }),
  ),
  themeCss(
    ember,
    resolveTheme({
      light: { accent: '#a5440f', bg: '#f5f2ef', 'surface-sunken': '#ece7e2', border: '#dcd5ce' },
      dark: { accent: '#ff9a5c', bg: '#12100e', surface: '#1a1714', 'surface-raised': '#24201c' },
    }),
  ),
].join('')
