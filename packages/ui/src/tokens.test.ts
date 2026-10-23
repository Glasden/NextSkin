import {
  checkTheme,
  describeThemeIssue,
  diamond,
  diamondStructure,
  lockedColorNames,
  structureVariables,
  themeColorNames,
} from '@nextskin/theme'
import { describe, expect, it } from 'vitest'
import designDoc from '../../../docs/DESIGN.md?raw'
import diamondModule from '../../theme/src/diamond.ts?raw'
import themeCss from './theme.css?raw'
import {
  extractSyncBlock,
  parseTheme,
  renderDiamondModule,
  renderTokenTables,
  replaceSyncBlock,
  SYNC_END,
  SYNC_START,
} from './tokens.ts'

describe('parseTheme', () => {
  it('只读 theme 中的 token，跳过 initial、合并行高、读取暗色覆盖和同行注释', () => {
    const theme = parseTheme(`
:root {
  --color-outside: #ff0000;
}
@theme static {
  --color-*: initial;
  --color-bg: #ffffff; /* 页面底色 */
  --color-text: #123456;
  --text-*: initial;
  --text-sm: 14px; /* 正文 */
  --text-sm--line-height: 20px;
  --font-sans: 'A Font', sans-serif; /* 字体 */
  --font-pixel:
    'B Font',
    var(--font-sans); /* 折行的值 */
  --shadow-pixel: 2px 2px 0 0 var(--color-text); /* 阴影 */
  --ease-step: steps(4, end);
  /* 不属于上一行 */
}
@custom-variant dark (&:where([data-mode='dark'], [data-mode='dark'] *));
@layer base {
  [data-mode='dark'] {
    --color-bg: #000000;
    --color-outside: #00ff00;
  }
}
`)

    expect(theme).toEqual({
      colors: [
        { name: 'bg', light: '#ffffff', dark: '#000000', note: '页面底色' },
        { name: 'text', light: '#123456', dark: undefined, note: '' },
      ],
      others: [
        { name: 'text-sm', value: '14px', lineHeight: '20px', note: '正文' },
        { name: 'font-sans', value: "'A Font', sans-serif", lineHeight: undefined, note: '字体' },
        { name: 'font-pixel', value: "'B Font', var(--font-sans)", lineHeight: undefined, note: '折行的值' },
        { name: 'shadow-pixel', value: '2px 2px 0 0 var(--color-text)', lineHeight: undefined, note: '阴影' },
        { name: 'ease-step', value: 'steps(4, end)', lineHeight: undefined, note: '' },
      ],
    })
  })

  it('没有 theme 块时抛错', () => {
    expect(() => parseTheme(':root { --color-bg: #ffffff; }')).toThrow()
  })
})

it('生成两张表，合并行高、转义竖线，末尾没有换行', () => {
  const theme = parseTheme(`@theme static {
  --color-bg: #ffffff; /* 底色 | 背景 */
  --text-sm: 14px; /* 正文 */
  --text-sm--line-height: 20px;
  --font-sans: 'A|B', sans-serif; /* 字体 */
}
[data-mode="dark"] {
  --color-bg: #000000;
}`)
  theme.colors.push({ name: 'text', light: '#123456', dark: undefined, note: '正文' })

  expect(renderTokenTables(theme)).toBe(
    [
      '| 颜色 | 亮色 | 暗色 | 用途 |',
      '|---|---|---|---|',
      '| `bg` | `#ffffff` | `#000000` | 底色 \\| 背景 |',
      '| `text` | `#123456` | — | 正文 |',
      '',
      '| Token | 值 | 用途 |',
      '|---|---|---|',
      '| `text-sm` | `14px / 20px` | 正文 |',
      "| `font-sans` | `'A\\|B', sans-serif` | 字体 |",
    ].join('\n'),
  )
})

describe('同步标记', () => {
  it('提取内容时只去掉首尾换行', () => {
    expect(extractSyncBlock(`${SYNC_START}\r\n\r\n 内容 \r\n\r\n${SYNC_END}`)).toBe(' 内容 ')
    expect(extractSyncBlock(`${SYNC_START}${SYNC_END}`)).toBe('')
  })

  it('替换只影响标记之间的内容，重复替换不变', () => {
    const doc = `前文\n${SYNC_START}\n旧内容\n${SYNC_END}\n后文\n`
    const updated = replaceSyncBlock(doc, '新内容\n第二行')
    expect(updated).toBe(`前文\n${SYNC_START}\n新内容\n第二行\n${SYNC_END}\n后文\n`)
    expect(replaceSyncBlock(updated, '新内容\n第二行')).toBe(updated)
  })

  it.each(['无标记', SYNC_START, SYNC_END, `${SYNC_END}\n${SYNC_START}`])('缺少标记或顺序不对时抛错：%s', (doc) => {
    expect(() => extractSyncBlock(doc)).toThrow()
    expect(() => replaceSyncBlock(doc, '新内容')).toThrow()
  })
})

describe('theme.css', () => {
  const theme = parseTheme(themeCss)

  it('每个颜色都有暗色值，每个 token 都有用途，且没有重名', () => {
    expect(theme.colors.length).toBeGreaterThan(0)
    expect(theme.others.length).toBeGreaterThan(0)
    for (const color of theme.colors) {
      expect(color.dark, `${color.name} 缺少暗色值`).toBeDefined()
    }
    for (const token of [...theme.colors, ...theme.others]) {
      expect(token.note.trim(), `${token.name} 缺少用途注释`).not.toBe('')
    }
    const names = [...theme.colors.map(({ name }) => `color-${name}`), ...theme.others.map(({ name }) => name)]
    expect(new Set(names).size).toBe(names.length)
  })

  // 对比度、明暗方向、强调色和危险色的距离，和插件主题同一套检查（packages/theme，ADR-0057）
  it('亮暗两套颜色都通过主题检查', () => {
    const colors = (mode: 'light' | 'dark') =>
      Object.fromEntries(theme.colors.map((color) => [color.name, color[mode]])) as (typeof diamond)['light']
    const issues = checkTheme({ light: colors('light'), dark: colors('dark') })
    expect(issues.map(describeThemeIssue)).toEqual([])
  })

  it('颜色正好是主题能改的加上锁住的', () => {
    expect(theme.colors.map(({ name }) => name).sort()).toEqual([...themeColorNames, ...lockedColorNames].sort())
  })

  it('packages/theme 里钻石青的取值与 theme.css 一致', () => {
    const message = 'packages/theme/src/diamond.ts 过期了，运行 pnpm design:sync'
    expect(diamondModule, message).toBe(renderDiamondModule(theme))
    for (const color of theme.colors) {
      expect(diamond.light[color.name as keyof typeof diamond.light], message).toBe(color.light)
      expect(diamond.dark[color.name as keyof typeof diamond.dark], message).toBe(color.dark)
    }
  })

  // 主题的结构生成的是同名变量（ADR-0058），钻石青那一组必须就是 theme.css 的默认值
  it('packages/theme 里钻石青的结构与 theme.css 一致', () => {
    for (const [name, value] of Object.entries(structureVariables(diamondStructure)))
      expect(theme.others.find((token) => token.name === name)?.value, name).toBe(value)
  })

  it('DESIGN.md 的 token 表与 theme.css 一致', () => {
    const message = 'DESIGN.md 的 token 表过期了，运行 pnpm design:sync'
    expect(() => extractSyncBlock(designDoc), message).not.toThrow()
    expect(extractSyncBlock(designDoc), message).toBe(renderTokenTables(theme))
  })
})
