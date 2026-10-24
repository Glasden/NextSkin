// 诊断页的服务端部分和日志查看器（客户端）共用，不能放在 'use client' 的文件里

import type { LogLevel } from '@nextskin/logging'

/** 剩余空间少于 1 GB 或总量的 5% 时提示 */
export const LOW_SPACE_BYTES = 1024 ** 3
export const LOW_SPACE_RATIO = 0.05

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 时长取最大的两个单位，交给 admin.diagnostics.durations 的文案；不到 1 分钟算 0 分钟 */
export function durationParts(
  milliseconds: number,
): { days: number; hours: number } | { hours: number; minutes: number } | { minutes: number } {
  const value = Math.max(0, milliseconds)
  if (value >= DAY) return { days: Math.floor(value / DAY), hours: Math.floor((value % DAY) / HOUR) }
  if (value >= HOUR) return { hours: Math.floor(value / HOUR), minutes: Math.floor((value % HOUR) / MINUTE) }
  return { minutes: Math.floor(value / MINUTE) }
}

/** 同 @nextskin/logging 的 LOG_LEVELS：那个包带着 Pino 和 node:fs，浏览器里不引入 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const satisfies readonly LogLevel[]

/** 日志记录里固定的字段，其余的字段在内容一栏里写成 键=值 */
export const LOG_RECORD_FIELDS = new Set(['time', 'level', 'source', 'msg', 'area', 'plugin', 'raw'])

/** 筛选里能选的来源。管理进程自己的行只写终端，不进日志文件（ADR-0062） */
export const LOG_SOURCES = ['launcher', 'core', 'plugin-host', 'plugin'] as const
