import { expect, test } from 'vitest'
import { toNumber } from './index.ts'

test('toNumber 兼容各驱动的结果类型，并检查安全整数边界', () => {
  for (const input of [0, '42', 42n, Number.MAX_SAFE_INTEGER, String(Number.MIN_SAFE_INTEGER)]) {
    expect(toNumber(input)).toBe(Number(input))
  }
  for (const input of [
    9007199254740992n,
    '9007199254740993',
    '-9007199254740993',
    Infinity,
    NaN,
    1.5,
    '',
    '1.5',
    'garbage',
  ]) {
    expect(() => toNumber(input)).toThrow(RangeError)
  }
})
