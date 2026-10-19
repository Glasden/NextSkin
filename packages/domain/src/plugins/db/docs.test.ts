import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
  AGGREGATES,
  BINARY_OPERATORS,
  DATA_TYPE,
  FK_ACTIONS,
  FUNCTIONS,
  JOIN_TYPES,
  SELECT_MODIFIERS,
  UNARY_OPERATORS,
} from './sanitize.ts'

const markdown = readFileSync(new URL('../../../../plugin-sdk/docs/tables.md', import.meta.url), 'utf8')
const lists = { BINARY_OPERATORS, UNARY_OPERATORS, FUNCTIONS, AGGREGATES, JOIN_TYPES, SELECT_MODIFIERS, FK_ACTIONS }

function documented(name: string): string[] {
  const start = '<!-- whitelist:' + name + ' -->'
  const end = '<!-- /whitelist:' + name + ' -->'
  expect(markdown.split(start)).toHaveLength(2)
  const block = markdown.split(start)[1]!.split(end)
  expect(block).toHaveLength(2)
  return block[0]!
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^- `([^`]+)`$/.exec(line)
      expect(match, name + ': ' + line).not.toBeNull()
      return match![1]!
    })
}

test.each(Object.entries(lists))('插件表文档的 %s 与网关白名单完全一致', (name, allowed) => {
  expect(documented(name).sort()).toEqual([...allowed].sort())
})

test('文档列出的数据类型正则片段组合后与网关完全一致', () => {
  // 比较整个表达式，新增类型、放宽或收紧参数范围都会要求同步文档。
  const pattern = new RegExp('^(?:' + documented('DATA_TYPE').join('|') + ')$')
  expect(pattern.source).toBe(DATA_TYPE.source)
  expect(pattern.flags).toBe(DATA_TYPE.flags)
})

test('所有白名单区块都参与比对', () => {
  const names = [...markdown.matchAll(/<!-- whitelist:([A-Z_]+) -->/g)].map((match) => match[1]!)
  expect(names.sort()).toEqual([...Object.keys(lists), 'DATA_TYPE'].sort())
})
