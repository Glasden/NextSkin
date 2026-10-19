import { expect, test } from 'vitest'
import { PluginPackageError } from './error.ts'
import { readTar, writeTar } from './tar.ts'

const limits = { maxFiles: 1000, maxPathLength: 200, maxDepth: 8, maxBytes: 64 * 1024 * 1024 }
const file = { path: 'server.mjs', bytes: new TextEncoder().encode('export default {}') }

/** 改头后重新计算 checksum，让测试确实走到目标字段的检查。 */
function changeHeader(bytes: Uint8Array, offset: number, value: string): Uint8Array {
  const result = bytes.slice()
  result.set(new TextEncoder().encode(value), offset)
  result.fill(32, 148, 156)
  const sum = result.subarray(0, 512).reduce((n, b) => n + b, 0)
  result.set(new TextEncoder().encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
  return result
}

test('ustar 往返、固定元数据、prefix、空文件与空归档', () => {
  const files = [file, { path: `${'a'.repeat(90)}/${'b'.repeat(80)}.json`, bytes: new Uint8Array() }]
  const bytes = writeTar(files)
  expect(readTar(bytes, limits)).toEqual(files)
  expect(bytes.subarray(100, 108)).toEqual(new TextEncoder().encode('0000644\0'))
  expect(bytes.subarray(108, 124)).toEqual(new TextEncoder().encode('0000000\0'.repeat(2)))
  expect(bytes.subarray(136, 148)).toEqual(new TextEncoder().encode('00000000000\0'))
  expect(bytes.subarray(265, 329).every((b) => b === 0)).toBe(true)
  expect(readTar(writeTar([]), limits)).toEqual([])
  expect(writeTar(files)).toEqual(bytes)
})

test.each(['1', '2', '3', '4', '6', 'x', 'g', 'L', 'K'])('拒绝 tar 类型 %s', (type) => {
  expect(() => readTar(changeHeader(writeTar([file]), 156, type), limits)).toThrow(
    expect.objectContaining({ code: 'unsupported_entry' }),
  )
})

test('普通文件允许 NUL typeflag，目录被忽略', () => {
  expect(readTar(changeHeader(writeTar([file]), 156, '\0'), limits)).toEqual([file])
  const dir = changeHeader(writeTar([{ path: 'locales/', bytes: new Uint8Array() }]), 156, '5')
  expect(readTar(dir, limits)).toEqual([])
})

test('拒绝损坏的 checksum、magic、size、截断、结束块后数据', () => {
  const corrupt = writeTar([file])
  corrupt[0] = 0
  const trailing = new Uint8Array(2048)
  trailing.set(writeTar([]))
  trailing[1024] = 1
  for (const bytes of [
    corrupt,
    changeHeader(writeTar([file]), 257, 'xxxxx'),
    changeHeader(writeTar([file]), 124, '77777777777\0'),
    changeHeader(writeTar([file]), 124, '00000000008\0'),
    changeHeader(writeTar([file]), 124, '0\0garbage\0\0\0'),
    writeTar([file]).slice(0, -512),
    writeTar([file]).slice(0, -1),
    trailing,
  ]) {
    expect(() => readTar(bytes, limits)).toThrow(expect.objectContaining({ code: 'invalid_archive' }))
  }
})

test.each([
  '../server.mjs',
  '/server.mjs',
  'a//b',
  'a\\b',
  '.hidden',
  'a:b',
  'file\n',
  `${'a'.repeat(101)}`,
  'a/b/c/d/e/f/g/h/i',
  'a/'.repeat(101) + 'b',
])('拒绝非法或过长路径 %s', (path) => {
  expect(() => readTar(writeTar([{ path, bytes: new Uint8Array() }]), limits)).toThrow(PluginPackageError)
})

test('文件数、大小、路径重复的限制', () => {
  expect(() => readTar(writeTar([file, file]), limits)).toThrow(expect.objectContaining({ code: 'duplicate_path' }))
  expect(() => readTar(writeTar([file, { ...file, path: 'SERVER.MJS' }]), limits)).toThrow(
    expect.objectContaining({ code: 'duplicate_path' }),
  )
  expect(() => readTar(writeTar([file]), { ...limits, maxFiles: 0 })).toThrow(
    expect.objectContaining({ code: 'too_many_files' }),
  )
  expect(() => readTar(writeTar([file]), { ...limits, maxBytes: 10 })).toThrow(
    expect.objectContaining({ code: 'too_large' }),
  )
})
