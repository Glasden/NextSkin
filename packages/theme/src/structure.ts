/**
 * 主题的结构（ADR-0058）：三项，每项两个取值，第一个是钻石青的。插件交的是这些枚举，
 * 对应的 CSS 变量和取值由核心定，不是插件 API。每个取值都在 DESIGN.md §2 的范围里，哪种组合都不用检查
 */
export const themeStructureOptions = {
  radius: ['rounded', 'square'],
  borders: ['thin', 'thick'],
  cards: ['flat', 'raised'],
} as const

export type ThemeStructureKey = keyof typeof themeStructureOptions

/** 补齐以后的结构 */
export type ResolvedStructure = { readonly [K in ThemeStructureKey]: (typeof themeStructureOptions)[K][number] }

/** 主题交的结构：每项都可以省略，省略的取钻石青 */
export type ThemeStructure = Partial<ResolvedStructure>

const structureKeys = Object.keys(themeStructureOptions) as ThemeStructureKey[]

export const diamondStructure: ResolvedStructure = { radius: 'rounded', borders: 'thin', cards: 'flat' }

/**
 * 每个取值对应的 CSS 变量（不带 `--`），钻石青的那一组和 packages/ui/src/theme.css 一致（ui 的 tokens.test.ts 守着）。
 * 选中框总是常规边框的两倍；静止阴影同 shadow-pixel-lg。没有阴影写成透明的零阴影，不写 none：
 * shadow-(--card-shadow) 把它放进 box-shadow 的逗号列表，none 会让整条声明失效，同一元素上的 ring 跟着消失
 */
const variables: { readonly [K in ThemeStructureKey]: Record<ResolvedStructure[K], Readonly<Record<string, string>>> } =
  {
    radius: {
      rounded: { 'radius-sm': '2px', 'radius-md': '4px' },
      square: { 'radius-sm': '0', 'radius-md': '0' },
    },
    borders: {
      thin: { 'border-width-base': '1px', 'outline-width-selected': '2px' },
      thick: { 'border-width-base': '2px', 'outline-width-selected': '4px' },
    },
    cards: {
      flat: { 'card-shadow': '0 0 #0000' },
      raised: { 'card-shadow': '4px 4px 0 0 var(--color-shadow)' },
    },
  }

function isOption<K extends ThemeStructureKey>(key: K, value: unknown): value is ResolvedStructure[K] {
  return (themeStructureOptions[key] as readonly unknown[]).includes(value)
}

/** 补齐结构：没写的和不认识的取钻石青。形状由 themeStructureError 检查 */
export function resolveStructure(structure: ThemeStructure = {}): ResolvedStructure {
  const result: Record<string, string> = { ...diamondStructure }
  for (const key of structureKeys) {
    const value = structure[key]
    if (isOption(key, value)) result[key] = value
  }
  return result as ResolvedStructure
}

/** 一套结构的全部 CSS 变量（不带 `--`），按 radius、borders、cards 的顺序 */
export function structureVariables(structure: ResolvedStructure): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const key of structureKeys) {
    const options: Readonly<Record<string, Readonly<Record<string, string>>>> = variables[key]
    Object.assign(result, options[structure[key]])
  }
  return result
}

/** 结构的形状不对时返回原因（给插件作者看），对了返回 null */
export function themeStructureError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'structure 必须是对象'
  for (const [key, option] of Object.entries(value)) {
    if (!(structureKeys as string[]).includes(key)) return `structure 里没有 ${key} 这一项`
    if (!isOption(key as ThemeStructureKey, option))
      return `structure.${key} 只能是 ${themeStructureOptions[key as ThemeStructureKey].join('、')}：${JSON.stringify(option)}`
  }
  return null
}
