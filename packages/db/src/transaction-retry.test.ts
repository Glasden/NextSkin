import { expect, test } from 'vitest'
import { isRetryableTransactionError } from './transaction-retry.ts'

test.each([
  [{ errno: 1213, code: 'ER_LOCK_DEADLOCK', sqlState: '40001' }, true],
  [{ errno: 1213, message: 'omitted' }, true],
  [{ code: '40P01' }, true],
  [{ code: '40001' }, true],
  [{ errno: 1205, sqlState: '40001' }, false],
  [{ errno: 1062 }, false],
  [{ code: '23505' }, false],
  [{ code: 'SQLITE_BUSY' }, false],
  [{ message: 'deadlock 1213' }, false],
  [null, false],
  [undefined, false],
  ['40001', false],
])('识别整个事务需要重试的错误 %j', (error, expected) => {
  expect(isRetryableTransactionError(error)).toBe(expected)
})
