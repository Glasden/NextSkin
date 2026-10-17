import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { colors, fontSans } from './tokens.ts'

// theme.css 里亮色的取值写在 @theme static 块里，排在暗色覆盖之前
const themeCss = readFileSync(new URL('../../ui/src/theme.css', import.meta.url), 'utf8')
const lightBlock = /@theme\s+static\s*\{([^}]*)\}/.exec(themeCss)?.[1] ?? ''
const declared = (name: string) =>
  new RegExp(`--${name}:\\s*([^;]+);`).exec(lightBlock)?.[1]?.replace(/\s+/g, ' ').trim()

test('邮件用的颜色和 theme.css 的亮色取值一致', () => {
  for (const [name, value] of Object.entries(colors)) {
    expect(value, `改了 theme.css 的 --color-${name}，同步 packages/email/src/tokens.ts`).toBe(
      declared(`color-${name}`),
    )
  }
})

test('邮件用的字体栈和 theme.css 一致', () => {
  expect(fontSans).toBe(declared('font-sans'))
})
