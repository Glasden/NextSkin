import { DomainError } from './errors.ts'

/**
 * 用户填的文本里不能有 U+0000：PostgreSQL 的 text 存不了它（报 22021），另外三种数据库存得了。
 * 一律拒绝，四种数据库的结果才一致
 */
export function rejectNul(text: string, code = 'invalid_request'): string {
  if (text.includes('\u0000')) throw new DomainError(code)
  return text
}
