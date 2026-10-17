import { expect, test } from 'vitest'
import { assertEmailVerified } from './email-verification.ts'

test('必须验证邮箱：支持 Better Auth 各库的布尔格式，关闭时放行', () => {
  for (const value of [false, 0]) {
    expect(() => assertEmailVerified({ email_verified: value }, true)).toThrow(
      expect.objectContaining({ code: 'email_not_verified' }),
    )
    expect(() => assertEmailVerified({ email_verified: value }, false)).not.toThrow()
  }
  for (const value of [true, 1]) expect(() => assertEmailVerified({ email_verified: value }, true)).not.toThrow()
})
