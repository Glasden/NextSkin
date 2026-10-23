import { isHexColor, mix } from './color.ts'
import { diamond } from './diamond.ts'
import {
  colorModes,
  MAX_PLUGIN_THEMES,
  MAX_THEME_NAME_LENGTH,
  THEME_NAME,
  themeColorNames,
  type ColorMode,
  type ColorName,
  type HexColor,
  type ThemeColorName,
} from './names.ts'

/** 主题交的数据：部分可改 token 在亮色、暗色下的取值，两种模式都可以省略、都可以只写一部分 */
export interface ThemeColors {
  readonly light?: Readonly<Partial<Record<ThemeColorName, string>>>
  readonly dark?: Readonly<Partial<Record<ThemeColorName, string>>>
}

/** 补齐以后的完整取值，也就是实际画到页面上的那一套 */
export type ResolvedTheme = Readonly<Record<ColorMode, Readonly<Record<ColorName, HexColor>>>>

/** 主题没写 accent-subtle 时，accent 按这个比例混入 surface */
export const ACCENT_SUBTLE_WEIGHT: Readonly<Record<ColorMode, number>> = { light: 0.12, dark: 0.16 }

const editable = new Set<string>(themeColorNames)

/**
 * 补齐一套主题：没写的 token 先按推导补（focus 等于 accent，accent-subtle 是 accent 混入 surface），
 * 其余的取钻石青；锁住的颜色总是钻石青。色值存成小写。只认可改的 token，别的键忽略，形状由 themeColorsError 检查
 */
export function resolveTheme(colors: ThemeColors = {}): ResolvedTheme {
  const resolve = (mode: ColorMode) => {
    const given: Partial<Record<ThemeColorName, HexColor>> = {}
    for (const [name, value] of Object.entries(colors[mode] ?? {}))
      if (editable.has(name) && isHexColor(value)) given[name as ThemeColorName] = value.toLowerCase() as HexColor
    const result: Record<ColorName, HexColor> = { ...diamond[mode], ...given }
    if (given.focus === undefined) result.focus = result.accent
    if (given['accent-subtle'] === undefined)
      result['accent-subtle'] = mix(result.accent, result.surface, ACCENT_SUBTLE_WEIGHT[mode])
    return result
  }
  return { light: resolve('light'), dark: resolve('dark') }
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 主题数据的形状不对时返回原因（给插件作者看），对了返回 null */
export function themeColorsError(value: unknown): string | null {
  if (!plain(value)) return 'colors 必须是对象'
  for (const key of Object.keys(value)) if (key !== 'light' && key !== 'dark') return `colors 里没有 ${key} 这一项`
  for (const mode of colorModes) {
    const colors = value[mode]
    if (colors === undefined) continue
    if (!plain(colors)) return `colors.${mode} 必须是对象`
    for (const [name, color] of Object.entries(colors)) {
      if (!editable.has(name)) return `colors.${mode} 里的 ${name} 不是主题能改的颜色`
      if (!isHexColor(color)) return `colors.${mode}.${name} 必须是 #rrggbb：${JSON.stringify(color)}`
    }
  }
  return null
}

/** 插件在 `ui.themes` 里声明的一套主题 */
export interface PluginTheme {
  readonly name: string
  readonly label: string
  readonly colors: ThemeColors
}

/** 插件的 `ui.themes` 形状不对时返回原因，对了返回 null。不查对比度，那是 checkTheme 的事 */
export function pluginThemesError(value: unknown): string | null {
  if (!Array.isArray(value)) return 'themes 必须是数组'
  if (value.length > MAX_PLUGIN_THEMES) return `一个插件最多声明 ${MAX_PLUGIN_THEMES} 套主题`
  const names = new Set<string>()
  for (const [index, theme] of value.entries()) {
    if (!plain(theme)) return `themes[${index}] 必须是对象`
    for (const key of Object.keys(theme))
      if (key !== 'name' && key !== 'label' && key !== 'colors') return `themes[${index}] 里没有 ${key} 这一项`
    const { name, label, colors } = theme
    if (typeof name !== 'string' || name.length > MAX_THEME_NAME_LENGTH || !THEME_NAME.test(name))
      return `themes[${index}] 的 name 只能用小写字母、数字和单个连字符，最多 ${MAX_THEME_NAME_LENGTH} 个字符`
    if (names.has(name)) return `主题 ${name} 重复了`
    names.add(name)
    if (typeof label !== 'string') return `主题 ${name} 的 label 必须是文案键`
    const error = themeColorsError(colors)
    if (error) return `主题 ${name} 的 ${error}`
  }
  return null
}

/** 色值转成小写：manifest 里存的是这个样子 */
export function normalizeThemeColors(colors: ThemeColors): ThemeColors {
  const lower = (values: ThemeColors['light']) =>
    values && Object.fromEntries(Object.entries(values).map(([name, color]) => [name, color?.toLowerCase()]))
  return {
    ...(colors.light ? { light: lower(colors.light) } : {}),
    ...(colors.dark ? { dark: lower(colors.dark) } : {}),
  }
}
