import { expect, test } from 'vitest'
import { lineSplitter } from './lines.ts'

test('按行切开：跨块的行拼起来，去掉行尾的 \\r，空行不交出去，结束时交出最后半行', () => {
  const lines: string[] = []
  const split = lineSplitter(100, (line) => lines.push(line))
  split.push('a\r\nb')
  split.push('c\n\n')
  split.push('d')
  split.end()
  expect(lines).toEqual(['a', 'bc', 'd'])
})

test('一直不换行时攒到上限就交出去，剩下的丢到下一个换行为止', () => {
  const lines: string[] = []
  const split = lineSplitter(5, (line) => lines.push(line))
  split.push('123')
  split.push('4567890')
  split.push('abc\nnext')
  split.end()
  expect(lines).toEqual(['12345', 'next'])
})
