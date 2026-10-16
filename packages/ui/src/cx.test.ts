import { expect, it } from 'vitest'
import { cx } from './cx.ts'

it('跳过假值', () => {
  expect(cx('a', false, null, undefined, '', 'b')).toBe('a b')
})
