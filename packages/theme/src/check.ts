import { contrastRatio, oklabDistance, relativeLuminance } from './color.ts'
import { colorModes, type ColorMode, type ColorName, type HexColor } from './names.ts'
import type { ResolvedTheme } from './resolve.ts'

/**
 * 对比度的组合：前景、背景、最低比值（正文 4.5:1，边框和焦点框 3:1，DESIGN.md §9）。
 * 规则也是插件 API 的一部分，只放宽、不收紧（ADR-0057"检查"）
 */
export const contrastPairs: readonly (readonly [ColorName, ColorName, number])[] = [
  ['text', 'bg', 4.5],
  ['text', 'surface', 4.5],
  ['text', 'surface-raised', 4.5],
  ['text', 'stage', 4.5],
  ['text', 'accent-subtle', 4.5],
  ['text-muted', 'bg', 4.5],
  ['text-muted', 'surface', 4.5],
  ['text-muted', 'surface-raised', 4.5],
  ['text-muted', 'surface-sunken', 4.5],
  ['text-muted', 'stage', 4.5],
  ['text-muted', 'accent-subtle', 4.5],
  ['text-inverse', 'text', 4.5],
  ['accent-fg', 'accent', 4.5],
  ['accent-fill-fg', 'accent-fill', 4.5],
  ['accent', 'bg', 4.5],
  ['accent', 'surface', 4.5],
  ['success-fg', 'success', 4.5],
  ['success', 'surface', 4.5],
  ['warning-fg', 'warning', 4.5],
  ['warning', 'surface', 4.5],
  ['danger-fg', 'danger', 4.5],
  ['danger', 'surface', 4.5],
  ['border-strong', 'surface', 3],
  ['border-strong', 'bg', 3],
  ['focus', 'bg', 3],
  ['focus', 'surface', 3],
]

/**
 * 亮色下前一个比 text 亮，暗色下比 text 暗。theme.css 只在暗色下设 color-scheme: dark，
 * 把深色底塞进亮色的话，浏览器自己画的滚动条、输入框和底色对不上，二维码也会反色
 */
export const lightnessPairs: readonly (readonly [ColorName, ColorName])[] = [
  ['bg', 'text'],
  ['text-inverse', 'text'],
]

/**
 * 强调色和危险色不能看着一样：两者在 OKLab 里至少差这么多。主要按钮用的是色块 accent-fill（ADR-0058），
 * 选中态和链接用的是 accent，两组都查
 */
export const distancePairs: readonly (readonly [ColorName, ColorName, number])[] = [
  ['accent', 'danger', 0.12],
  ['accent-fill', 'danger', 0.12],
]

export type ThemeIssue =
  | {
      mode: ColorMode
      check: 'contrast' | 'distance'
      pair: readonly [ColorName, ColorName]
      values: readonly [HexColor, HexColor]
      actual: number
      minimum: number
    }
  | {
      mode: ColorMode
      check: 'lightness'
      pair: readonly [ColorName, ColorName]
      values: readonly [HexColor, HexColor]
    }

const fills = new Set<ColorName>(['accent-fill', 'accent-fill-fg'])

/**
 * 检查补齐以后的取值，没有问题时返回空数组。色块的两组和 accent 的那两组查出同一组值时不重复报：
 * 没写色块的主题，accent-fill、accent-fill-fg 就是 accent、accent-fg
 */
export function checkTheme(theme: ResolvedTheme): ThemeIssue[] {
  const issues: ThemeIssue[] = []
  const seen = new Set<string>()
  const report = (issue: ThemeIssue) => {
    const key = `${issue.mode} ${issue.check} ${issue.values.join(' ')}`
    if (issue.pair.some((name) => fills.has(name)) && seen.has(key)) return
    seen.add(key)
    issues.push(issue)
  }
  for (const mode of colorModes) {
    const colors = theme[mode]
    const values = (pair: readonly [ColorName, ColorName]) => [colors[pair[0]], colors[pair[1]]] as const
    for (const [foreground, background, minimum] of contrastPairs) {
      const pair = [foreground, background] as const
      const actual = contrastRatio(colors[foreground], colors[background])
      if (actual < minimum) report({ mode, check: 'contrast', pair, values: values(pair), actual, minimum })
    }
    for (const pair of lightnessPairs) {
      const [first, second] = pair.map((name) => relativeLuminance(colors[name])) as [number, number]
      if (mode === 'light' ? first <= second : first >= second)
        report({ mode, check: 'lightness', pair, values: values(pair) })
    }
    for (const [first, second, minimum] of distancePairs) {
      const pair = [first, second] as const
      const actual = oklabDistance(colors[first], colors[second])
      if (actual < minimum) report({ mode, check: 'distance', pair, values: values(pair), actual, minimum })
    }
  }
  return issues
}

/** 给插件作者看的一句话：构建命令的报错、后台主题页列出的原因 */
export function describeThemeIssue(issue: ThemeIssue): string {
  const mode = issue.mode === 'light' ? '亮色' : '暗色'
  const [first, second] = issue.pair
  const values = `${issue.values[0]} / ${issue.values[1]}`
  switch (issue.check) {
    case 'contrast':
      return `${mode}下 ${first} 和 ${second} 的对比度 ${issue.actual.toFixed(2)} 低于 ${issue.minimum}（${values}）`
    case 'distance':
      return `${mode}下 ${first} 和 ${second} 在 OKLab 里只差 ${issue.actual.toFixed(3)}，至少要 ${issue.minimum}（${values}）`
    case 'lightness':
      return `${mode}下 ${first} 要比 ${second} ${issue.mode === 'light' ? '亮' : '暗'}（${values}）`
  }
}
