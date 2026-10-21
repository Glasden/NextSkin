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

/**
 * 存进数据库、靠唯一索引去重或查找的键（插件 KV 的键、任务去重键、插件改积分的幂等键）：1 到 maxLength 个码位，并且
 * - 首尾没有空白：MySQL 的 utf8mb4_bin 比较时忽略末尾空格，另外三种数据库不会；
 * - 没有 U+0000：PostgreSQL 存不了；
 * - 没有不成对的代理项：写进数据库会变成 U+FFFD，两个不同的键就撞成了一个
 */
export function isStorageKey(key: string, maxLength: number): boolean {
  const length = [...key].length
  return length >= 1 && length <= maxLength && key === key.trim() && !key.includes('\u0000') && key.isWellFormed()
}
