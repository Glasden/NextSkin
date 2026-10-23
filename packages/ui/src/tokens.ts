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

export function contrastRatio(foreground: string, background: string): number {
  function luminance(color: string): number {
    if (color.length !== 7 || !/^#[\da-f]{6}$/i.test(color)) throw new Error(`颜色必须是 #rrggbb：${color}`)
    const channels = [1, 3, 5].map((offset) => {
      const channel = parseInt(color.slice(offset, offset + 2), 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  }

  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
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
