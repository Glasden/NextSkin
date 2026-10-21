import { readFileSync, writeFileSync } from 'node:fs'
import { FAVICON_FILES, renderFavicons } from '../src/logo/favicon.ts'
import { parseTheme, renderTokenTables, replaceSyncBlock } from '../src/tokens.ts'

const css = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8')
const theme = parseTheme(css)
const docPath = new URL('../../../DESIGN.md', import.meta.url)
const doc = readFileSync(docPath, 'utf8')
const updated = replaceSyncBlock(doc, renderTokenTables(theme))

if (updated !== doc) {
  writeFileSync(docPath, updated)
  console.log('DESIGN.md 已更新')
} else {
  console.log('DESIGN.md 已是最新')
}

// 默认的站点图标由标志的图形和 token 生成（ADR-0032），放在 public 目录；<link rel="icon"> 由根布局输出（ADR-0042）
const favicons = renderFavicons(theme)
for (const [key, name] of Object.entries(FAVICON_FILES) as [keyof typeof FAVICON_FILES, string][]) {
  const path = new URL(`../../../apps/web/public/${name}`, import.meta.url)
  const content = favicons[key]
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  let current: Uint8Array | undefined
  try {
    current = readFileSync(path)
  } catch {
    current = undefined
  }
  if (current && Buffer.compare(current, bytes) === 0) {
    console.log(`${name} 已是最新`)
  } else {
    writeFileSync(path, bytes)
    console.log(`${name} 已更新`)
  }
}
