import { expect, it } from 'vitest'
import designDoc from '../../../docs/DESIGN.md?raw'

// DESIGN.md §6 的组件表和 src 下的组件对得上：带 story 的组件目录都有一行，规划中、还没写的标“（未落地）”
const PLANNED = '（未落地）'
// patterns 放的是几个组件拼成的页面片段（登录表单），不是组件
const NOT_COMPONENTS = new Set(['patterns'])

function pascalCase(directory: string): string {
  return directory
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

const components = new Set(
  Object.keys(import.meta.glob('./*/*.stories.tsx'))
    .map((path) => path.split('/')[1]!)
    .filter((directory) => !NOT_COMPONENTS.has(directory))
    .map(pascalCase),
)

/** §6 表格第一列的组件名，一格里可能有几个，用顿号隔开 */
const rows = designDoc
  .slice(designDoc.indexOf('\n## 6.'), designDoc.indexOf('\n## 7.'))
  .split('\n')
  .filter((line) => line.startsWith('|'))
  .map((line) => line.split('|')[1]!.trim())
  // 去掉表头和分隔行
  .filter((cell) => cell !== '组件' && !/^:?-+:?$/.test(cell))
  .flatMap((cell) => cell.split('、'))
  .map((cell) => ({ name: cell.replace(PLANNED, ''), planned: cell.endsWith(PLANNED) }))

it('能读到 §6 的组件表', () => {
  expect(rows.length).toBeGreaterThan(30)
  expect(components.size).toBeGreaterThan(30)
})

it('每个落地的组件在 DESIGN.md §6 里都有一行，并且没有标“（未落地）”', () => {
  const documented = new Set(rows.filter((row) => !row.planned).map((row) => row.name))
  expect(
    [...components].filter((name) => !documented.has(name)),
    '补上表格的行，或者去掉“（未落地）”',
  ).toEqual([])
})

it('DESIGN.md §6 里没标“（未落地）”的组件都已经落地，标了的都还没有', () => {
  expect(
    rows.filter((row) => row.planned === components.has(row.name)).map((row) => row.name),
    '组件落地了就去掉“（未落地）”；还没写的要标上',
  ).toEqual([])
})
