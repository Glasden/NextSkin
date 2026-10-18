import { expect, test } from 'vitest'
import { bsDateTime, isTimeZone, toFlag, toInt, toText } from './values.ts'

test('旧站的本地时间按旧站时区换算成 UTC，不看进程时区', () => {
  expect(bsDateTime('2026-01-01 08:00:00', 'Asia/Shanghai')).toBe('2026-01-01T00:00:00.000Z')
  expect(bsDateTime('2026-01-01 08:00:00', 'Asia/Tokyo')).toBe('2025-12-31T23:00:00.000Z')
  expect(bsDateTime('2026-07-01 08:00:00', 'America/New_York')).toBe('2026-07-01T12:00:00.000Z')
  expect(bsDateTime('2026-01-01 08:00:00', 'America/New_York')).toBe('2026-01-01T13:00:00.000Z')
  // PostgreSQL 的 timestamp 带微秒，timestamptz 带偏移
  expect(bsDateTime('2026-01-01 08:00:00.123456', 'UTC')).toBe('2026-01-01T08:00:00.123Z')
  expect(bsDateTime('2026-01-01 08:00:00+08', 'UTC')).toBe('2026-01-01T00:00:00.000Z')
  expect(bsDateTime('2026-01-01T08:00:00Z', 'Asia/Shanghai')).toBe('2026-01-01T08:00:00.000Z')
})

test('夏令时结束时重复的时刻取较早的一个', () => {
  // 2026-11-01 01:30 在纽约出现两次：先是 EDT（UTC-4），后是 EST（UTC-5）
  expect(bsDateTime('2026-11-01 01:30:00', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
})

test('零日期和不存在的日期读成 null', () => {
  for (const value of ['0000-00-00 00:00:00', '2026-02-30 00:00:00', '2026-01-01 24:00:00', 'yesterday', '', null, 42])
    expect(bsDateTime(value, 'Asia/Shanghai')).toBeNull()
})

test('三种数据库读出来的数字、布尔统一转换', () => {
  expect([toInt(5), toInt('5'), toInt('-1'), toInt(5n), toInt('5.0'), toInt(null), toInt('9007199254740993')]).toEqual([
    5,
    5,
    -1,
    5,
    null,
    null,
    null,
  ])
  expect([toFlag(true), toFlag(false), toFlag(1), toFlag(0), toFlag('1'), toFlag('0'), toFlag(null)]).toEqual([
    true,
    false,
    true,
    false,
    true,
    false,
    false,
  ])
  expect([toText('a'), toText(1), toText(null)]).toEqual(['a', '1', null])
  expect([isTimeZone('Asia/Shanghai'), isTimeZone('Mars/Base')]).toEqual([true, false])
})
