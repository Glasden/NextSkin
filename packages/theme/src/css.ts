import { isHexColor } from './color.ts'
import { lockedColorNames, themeColorNames, type ColorMode } from './names.ts'
import type { ResolvedTheme } from './resolve.ts'
import { structureVariables, type ResolvedStructure } from './structure.ts'

/** 内置主题和 `<插件 id>/<名字>`：只有小写字母、数字、连字符和一个斜杠，放进单引号的属性选择器里不用转义 */
const THEME_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/

export function isThemeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && THEME_ID.test(value)
}

/**
 * 一套主题的 CSS：两种模式下全部颜色的取值（已经补齐），限定在 `[data-theme='<id>']` 和
 * `[data-theme='<id>'][data-mode='dark']` 上。不在层里、后者的优先级更高，所以不依赖和 theme.css 之间的层叠顺序；
 * 限定在属性上，同一页里能同时画几套主题（主题页的小样）。锁住的颜色也写出来（总是钻石青的值）：
 * 暗色页面里的亮色小样不能从页面继承暗色的展台。结构不分亮暗，只写在前一块里，钻石青的也写（ADR-0058）：
 * 小样不能从页面继承别的主题的结构
 */
export function themeCss(id: string, theme: ResolvedTheme, structure: ResolvedStructure): string {
  if (!isThemeId(id)) throw new Error(`主题 id 格式不对：${JSON.stringify(id)}`)
  const declarations = (mode: ColorMode) =>
    [...themeColorNames, ...lockedColorNames]
      .map((name) => {
        const value: string = theme[mode][name]
        if (!isHexColor(value)) throw new Error(`颜色必须是 #rrggbb：${JSON.stringify(value)}`)
        return `--color-${name}:${value.toLowerCase()};`
      })
      .join('')
  const shape = Object.entries(structureVariables(structure))
    .map(([name, value]) => `--${name}:${value};`)
    .join('')
  const selector = `[data-theme='${id}']`
  return `${selector}{${declarations('light')}${shape}}${selector}[data-mode='dark']{${declarations('dark')}}`
}
