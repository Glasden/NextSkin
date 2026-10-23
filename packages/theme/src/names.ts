/**
 * 主题能改的颜色（ADR-0057"主题的形状"）。名字和 packages/ui/src/theme.css 里的 `--color-*` 相同，不带前缀。
 * 它们也是插件 SDK 的 `ThemeColor`：改名或删除是插件 API 的大版本。核心以后加颜色 token，要么加在这里
 * （同时给它一条从已有 token 推导的默认值，旧主题才照样通过检查），要么加进 lockedColorNames
 */
export const themeColorNames = [
  'bg',
  'surface',
  'surface-raised',
  'surface-sunken',
  'border',
  'border-strong',
  'text',
  'text-muted',
  'text-inverse',
  'accent',
  'accent-fg',
  'accent-subtle',
  'success',
  'success-fg',
  'warning',
  'warning-fg',
  'danger',
  'danger-fg',
  'focus',
  'shadow',
] as const

/** 在任何主题下都取钻石青的颜色：展台在亮暗两种模式下都取中间调，透明区域的棋盘格也跟着它（DESIGN.md §2.2） */
export const lockedColorNames = ['stage', 'checker-a', 'checker-b'] as const

export type ThemeColorName = (typeof themeColorNames)[number]
export type LockedColorName = (typeof lockedColorNames)[number]
/** theme.css 的全部颜色 */
export type ColorName = ThemeColorName | LockedColorName

export const colorModes = ['light', 'dark'] as const
export type ColorMode = (typeof colorModes)[number]

/** `#rrggbb`；存下来、生成 CSS 时一律小写 */
export type HexColor = `#${string}`

/** 内置主题钻石青的 id。内置主题的 id 没有斜杠，插件的主题是 `<插件 id>/<名字>`，两边不会撞上 */
export const DIAMOND = 'diamond'

/** 插件主题的名字：同一个插件里不重复 */
export const THEME_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const MAX_THEME_NAME_LENGTH = 32
/** 一个插件最多声明几套主题 */
export const MAX_PLUGIN_THEMES = 16

export function pluginThemeId(pluginId: string, name: string): string {
  return `${pluginId}/${name}`
}
