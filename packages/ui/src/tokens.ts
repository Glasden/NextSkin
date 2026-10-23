export interface ColorToken {
  name: string
  light: string
  dark: string | undefined
  note: string
}

export interface OtherToken {
  name: string
  value: string
  lineHeight: string | undefined
  note: string
}

export interface ThemeTokens {
  colors: ColorToken[]
  others: OtherToken[]
}

// 值可以跨行：Prettier 会把超过行宽的值（例如字体栈）折到下一行，用途注释仍在分号后面
function declarations(block: string) {
  return [...block.matchAll(/^[\t ]*--([\w*-]+):\s*([^;]+);[\t ]*(?:\/\*([^\r\n]*?)\*\/)?/gm)].map((match) => ({
    name: match[1]!,
    value: match[2]!.replace(/\s+/g, ' ').trim(),
    note: match[3]?.trim() ?? '',
  }))
}

export function parseTheme(css: string): ThemeTokens {
  const block = css.match(/@theme\s+static\s*\{([^}]*)\}/)?.[1]
  if (block === undefined) throw new Error('找不到 @theme static 块')

  const darkBlock = css.match(/\[data-mode\s*=\s*['"]dark['"]\]\s*\{([^}]*)\}/)?.[1] ?? ''
  const darkValues = new Map(declarations(darkBlock).map(({ name, value }) => [name, value]))
  const theme: ThemeTokens = { colors: [], others: [] }

  for (const { name, value, note } of declarations(block)) {
    if (name.endsWith('-*') && value === 'initial') continue
    if (name.endsWith('--line-height')) {
      const token = theme.others.find((token) => token.name === name.slice(0, -'--line-height'.length))
      if (token) token.lineHeight = value
    } else if (name.startsWith('color-')) {
      theme.colors.push({ name: name.slice('color-'.length), light: value, dark: darkValues.get(name), note })
    } else {
      theme.others.push({ name, value, lineHeight: undefined, note })
    }
  }

  return theme
}

export function renderTokenTables(theme: ThemeTokens): string {
  const escape = (value: string) => value.replaceAll('|', '\\|')
  const code = (value: string) => `\`${escape(value)}\``

  return [
    '| 颜色 | 亮色 | 暗色 | 用途 |',
    '|---|---|---|---|',
    ...theme.colors.map(
      ({ name, light, dark, note }) =>
        `| ${code(name)} | ${code(light)} | ${dark === undefined ? '—' : code(dark)} | ${escape(note)} |`,
    ),
    '',
    '| Token | 值 | 用途 |',
    '|---|---|---|',
    ...theme.others.map(
      ({ name, value, lineHeight, note }) =>
        `| ${code(name)} | ${code(lineHeight === undefined ? value : `${value} / ${lineHeight}`)} | ${escape(note)} |`,
    ),
  ].join('\n')
}

/**
 * 钻石青的全部颜色，写成 packages/theme 的 `diamond.ts`（ADR-0057）：插件主题没写的颜色取它，检查和生成 CSS 都用它。
 * theme.css 仍是唯一来源，由 `pnpm design:sync` 生成，tokens.test.ts 守着两边一致
 */
export function renderDiamondModule(theme: ThemeTokens): string {
  const key = (name: string) => (/^[a-z]+$/.test(name) ? name : `'${name}'`)
  const block = (mode: 'light' | 'dark') =>
    theme.colors.map((color) => `    ${key(color.name)}: '${color[mode] ?? ''}',`).join('\n')
  return [
    '// 由 `pnpm design:sync` 从 packages/ui/src/theme.css 生成，不要手改；packages/ui 的 tokens.test.ts 守着两边一致',
    "import type { ColorMode, ColorName, HexColor } from './names.ts'",
    '',
    '/** 默认主题钻石青的全部颜色（ADR-0057） */',
    'export const diamond: Readonly<Record<ColorMode, Readonly<Record<ColorName, HexColor>>>> = {',
    '  light: {',
    block('light'),
    '  },',
    '  dark: {',
    block('dark'),
    '  },',
    '}',
    '',
  ].join('\n')
}

export const SYNC_START = '<!-- design:sync:start -->'
export const SYNC_END = '<!-- design:sync:end -->'

function syncRange(doc: string): [number, number] {
  const start = doc.indexOf(SYNC_START)
  const end = doc.indexOf(SYNC_END)
  if (start < 0 || end < start + SYNC_START.length) throw new Error('DESIGN.md 缺少 design:sync 标记或顺序不对')
  return [start, end]
}

export function extractSyncBlock(doc: string): string {
  const [start, end] = syncRange(doc)
  return doc.slice(start + SYNC_START.length, end).replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '')
}

export function replaceSyncBlock(doc: string, content: string): string {
  const [start, end] = syncRange(doc)
  return `${doc.slice(0, start)}${SYNC_START}\n${content}\n${SYNC_END}${doc.slice(end + SYNC_END.length)}`
}
