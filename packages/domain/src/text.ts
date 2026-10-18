import { DomainError } from './errors.ts'

// PHP trim() 默认去掉的字符
const PHP_WHITESPACE = new Set([' ', '\t', '\n', '\r', '\0', '\x0B'])

/** PHP 的 trim()。BS 的 TrimStrings 中间件用它处理查询参数和 JSON 请求体里的字符串（路由参数不处理）。 */
export function phpTrim(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && PHP_WHITESPACE.has(value[start]!)) start++
  while (end > start && PHP_WHITESPACE.has(value[end - 1]!)) end--
  return value.slice(start, end)
}

/**
 * 用户填的文本里不能有 U+0000：PostgreSQL 的 text 存不了它（报 22021），另外三种数据库存得了。
 * 一律拒绝，四种数据库的结果才一致
 */
export function rejectNul(text: string, code = 'invalid_request'): string {
  if (text.includes('\u0000')) throw new DomainError(code)
  return text
}
