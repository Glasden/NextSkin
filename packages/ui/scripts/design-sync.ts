import { readFileSync, writeFileSync } from 'node:fs'
import { FAVICON_FILES, renderFavicons } from '../src/logo/favicon.ts'
import { parseTheme, renderDiamondModule, renderTokenTables, replaceSyncBlock } from '../src/tokens.ts'

const css = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8')
const theme = parseTheme(css)
const docPath = new URL('../../../docs/DESIGN.md', import.meta.url)
const doc = readFileSync(docPath, 'utf8')
const updated = replaceSyncBlock(doc, renderTokenTables(theme))

if (updated !== doc) {
  writeFileSync(docPath, updated)
  console.log('DESIGN.md 已更新')
} else {
  console.log('DESIGN.md 已是最新')
}

// 钻石青的取值写进 packages/theme：插件主题没写的颜色取它（ADR-0057）
const diamondPath = new URL('../../theme/src/diamond.ts', import.meta.url)
const diamond = renderDiamondModule(theme)
let currentDiamond: string | undefined
try {
  currentDiamond = readFileSync(diamondPath, 'utf8')
} catch {
  currentDiamond = undefined
}
if (currentDiamond === diamond) {
  console.log('packages/theme/src/diamond.ts 已是最新')
} else {
  writeFileSync(diamondPath, diamond)
  console.log('packages/theme/src/diamond.ts 已更新')
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
