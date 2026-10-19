import { readFileSync, readdirSync } from 'node:fs'
import { expect, test } from 'vitest'

const sdk = new URL('../../plugin-sdk/', import.meta.url)
const examples = [
  ['README.md', 'readme.ts'],
  ['docs/getting-started.md', 'getting-started.ts'],
] as const

test.each(examples)('%s 的完整入口和 type-tests/docs/%s 逐字一致', (document, file) => {
  const markdown = readFileSync(new URL(document, sdk), 'utf8')
  const blocks = [...markdown.matchAll(/<!-- docs-example: ([a-z-]+\.ts) -->\n\n```ts\n([\s\S]*?)```/g)]
  expect(blocks).toHaveLength(1)
  expect(blocks[0]![1]).toBe(file)
  expect(blocks[0]![2]).toBe(readFileSync(new URL('type-tests/docs/' + file, sdk), 'utf8'))
})

test('每个文档入口样例都被比对，且在 SDK 类型检查的 include 内', () => {
  expect(readdirSync(new URL('type-tests/docs/', sdk)).sort()).toEqual(examples.map(([, file]) => file).sort())
  const tsconfig = JSON.parse(readFileSync(new URL('tsconfig.json', sdk), 'utf8')) as { include: string[] }
  expect(tsconfig.include).toContain('type-tests')
})
