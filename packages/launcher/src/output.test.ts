import { expect, test } from 'vitest'
import { boundedTerminal } from './output.ts'

test('终端读不走时丢掉新的；恢复后补一条丢了几条，补的这一条越过上限也照写', () => {
  const written: string[] = []
  const reports: number[] = []
  let pending = 0
  const write = boundedTerminal(
    (line) => {
      written.push(line)
      pending += 10
    },
    () => pending,
    (dropped) => {
      reports.push(dropped)
      write(`dropped ${dropped}`)
    },
    15,
  )
  pending = 20
  for (let index = 0; index < 10; index++) write(`lost ${index}`)
  expect(written).toEqual([])
  pending = 0
  // 写完这一条积压就到了 10，补的那条写完是 20，已经越过上限
  write('back')
  write('next')
  expect(written).toEqual(['back', 'dropped 10'])
  expect(reports).toEqual([10])
  // next 被丢了，下一次写得出去时补上
  pending = 0
  write('again')
  expect(written).toEqual(['back', 'dropped 10', 'again', 'dropped 1'])
  expect(reports).toEqual([10, 1])
})
