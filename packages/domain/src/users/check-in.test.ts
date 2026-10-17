import { toIsoTimestamp } from '@nextskin/db'
import { expect, test } from 'vitest'
import { nextCheckInAt, type CheckInRules } from './check-in.ts'

const iso = (value: string) => toIsoTimestamp(new Date(value))
const rules: CheckInRules = { gapHours: 24, resetAtMidnight: false, timeZone: 'Asia/Shanghai' }

test('未签到、间隔边界和 gapHours 为 0 时现在可签', () => {
  const now = new Date('2026-10-17T12:00:00Z')
  expect(nextCheckInAt(null, now, rules)).toBeNull()
  expect(nextCheckInAt(iso('2026-10-16T12:00:00Z'), now, rules)).toBeNull()
  expect(nextCheckInAt(iso('2026-10-16T12:00:00.001Z'), now, rules)).toBe('2026-10-17T12:00:00.001Z')
  expect(nextCheckInAt(iso('2026-10-17T12:00:00Z'), now, { ...rules, gapHours: 0 })).toBeNull()
})

test.each([
  ['Asia/Shanghai', '2026-10-17T08:00:00Z', '2026-10-17T12:00:00Z', '2026-10-17T16:00:00.000Z'],
  ['UTC', '2026-10-17T08:00:00Z', '2026-10-17T12:00:00Z', '2026-10-18T00:00:00.000Z'],
  ['America/New_York', '2026-03-08T05:01:00Z', '2026-03-08T18:00:00Z', '2026-03-09T04:00:00.000Z'],
  ['America/New_York', '2026-11-01T04:01:00Z', '2026-11-01T18:00:00Z', '2026-11-02T05:00:00.000Z'],
])('按 %s 当地零点计算，忽略 gapHours：%s', (timeZone, last, now, expected) => {
  const config = { ...rules, resetAtMidnight: true, timeZone, gapHours: 999 }
  expect(nextCheckInAt(iso(last), new Date(now), config)).toBe(expected)
  expect(nextCheckInAt(iso(last), new Date(expected), config)).toBeNull()
})

test.each([
  ['Asia/Shanghai', '2026-10-16T16:00:00Z', '2026-10-17T00:00:00Z', '2026-10-17T16:00:00.000Z'],
  ['UTC', '2026-10-17T00:00:00Z', '2026-10-17T12:00:00Z', '2026-10-18T00:00:00.000Z'],
  ['America/New_York', '2026-03-08T05:00:00Z', '2026-03-08T18:00:00Z', '2026-03-09T04:00:00.000Z'],
  ['America/New_York', '2026-11-01T04:00:00Z', '2026-11-01T18:00:00Z', '2026-11-02T05:00:00.000Z'],
])('%s 恰好在零点签的那一次算当天的，下次是明天零点', (timeZone, last, now, next) => {
  const config = { ...rules, resetAtMidnight: true, timeZone }
  expect(nextCheckInAt(iso(last), new Date(now), config)).toBe(next)
  // 前一毫秒签的算昨天
  const before = toIsoTimestamp(new Date(new Date(last).getTime() - 1))
  expect(nextCheckInAt(before, new Date(now), config)).toBeNull()
})
