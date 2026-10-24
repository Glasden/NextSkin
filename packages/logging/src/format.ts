import type { LogRecord } from './record.ts'

/** 只在固定的列里显示，不再当作字段 */
const COLUMNS = new Set(['time', 'level', 'source', 'area', 'msg', 'raw'])

/**
 * 给人看的一行（终端、面板）：本机时区的时间、级别、来源和模块、消息、字段（ADR-0062）。
 * 插件写的记录，来源一栏是 `plugin/<id>`；核心写的、和某个插件有关的记录照常显示 `plugin=<id>`。
 * 控制字符一律转义：插件的消息和原始输出里的换行、终端转义序列不能伪造出另一行或改掉终端的显示
 */
export function formatLogText(record: LogRecord): string {
  const fromPlugin = record.source === 'plugin'
  const origin = [record.source, fromPlugin ? record.plugin : record.area].filter(Boolean).join('/')
  const parts = [formatLocalTime(new Date(record.time)), record.level.toUpperCase().padEnd(5), escape(origin)]
  if (record.msg) parts.push(escape(record.msg))
  for (const [key, value] of Object.entries(record)) {
    if (COLUMNS.has(key) || (fromPlugin && key === 'plugin')) continue
    // 插件的字段放在 fields 下（不能冒充核心的字段），显示时展开一层
    if (key === 'fields' && fromPlugin && isPlainObject(value)) {
      for (const [name, item] of Object.entries(value)) parts.push(`${escape(name)}=${formatValue(item)}`)
      continue
    }
    parts.push(`${escape(key)}=${formatValue(value)}`)
  }
  return parts.join(' ')
}

/** `2026-10-24 20:15:03.123`，本机时区 */
export function formatLocalTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return '????-??-?? ??:??:??.???'
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  )
}

function formatValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (typeof value === 'string' && /^[^\s"=]+$/u.test(value)) return escape(value)
  // JSON 只转义 U+001F 以内的控制字符，C1 控制字符还要再转一次
  return escape(JSON.stringify(value) ?? typeof value)
}

function escape(text: string): string {
  // eslint-disable-next-line no-control-regex -- 要找的就是控制字符
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    if (char === '\n') return '\\n'
    if (char === '\r') return '\\r'
    if (char === '\t') return '\\t'
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
