import { readFileSync, writeFileSync } from 'node:fs'
import { parseTheme, renderTokenTables, replaceSyncBlock } from '../src/tokens.ts'

const css = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8')
const docPath = new URL('../../../DESIGN.md', import.meta.url)
const doc = readFileSync(docPath, 'utf8')
const updated = replaceSyncBlock(doc, renderTokenTables(parseTheme(css)))

if (updated !== doc) {
  writeFileSync(docPath, updated)
  console.log('DESIGN.md 已更新')
} else {
  console.log('DESIGN.md 已是最新')
}
