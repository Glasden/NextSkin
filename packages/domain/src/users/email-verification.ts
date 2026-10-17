import { readAuthBoolean } from '@nextskin/db'
import { DomainError } from '../errors.ts'

/** 允许登录；需要邮箱验证的写用例在执行前调用。 */
export function assertEmailVerified(user: { email_verified: boolean | number }, required: boolean): void {
  if (required && !readAuthBoolean(user.email_verified)) throw new DomainError('email_not_verified')
}
