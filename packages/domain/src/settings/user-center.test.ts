import { expect, test } from 'vitest'
import { coreSettingsRegistry } from './registry.ts'

test('角色价格与签到设置保留边界和默认值', () => {
  expect(coreSettingsRegistry['score.perPlayer'].default).toBe(100)
  expect(coreSettingsRegistry['score.refundOnDelete'].default).toBe(true)
  expect(coreSettingsRegistry['checkIn.score'].default).toEqual({ min: 10, max: 100 })
  expect(coreSettingsRegistry['checkIn.gapHours'].default).toBe(24)
  expect(coreSettingsRegistry['checkIn.resetAtMidnight'].default).toBe(false)
  for (const n of [0, 2147483647]) {
    expect(coreSettingsRegistry['score.perPlayer'].schema.safeParse(n).success).toBe(true)
    expect(coreSettingsRegistry['checkIn.score'].schema.safeParse({ min: n, max: n }).success).toBe(true)
  }
  for (const n of [-1, 0.5, 2147483648]) {
    expect(coreSettingsRegistry['score.perPlayer'].schema.safeParse(n).success).toBe(false)
    expect(coreSettingsRegistry['checkIn.score'].schema.safeParse({ min: 0, max: n }).success).toBe(false)
  }
  expect(coreSettingsRegistry['checkIn.score'].schema.safeParse({ min: 2, max: 1 }).success).toBe(false)
  expect(coreSettingsRegistry['checkIn.gapHours'].schema.safeParse(0).success).toBe(true)
  expect(coreSettingsRegistry['checkIn.gapHours'].schema.safeParse(-1).success).toBe(false)
})
