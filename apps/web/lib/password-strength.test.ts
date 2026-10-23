import { describe, expect, test } from 'vitest'
import { passwordStrength } from './password-strength'

describe('passwordStrength', () => {
  test('没输入时不显示', () => {
    expect(passwordStrength('')).toBeNull()
  })

  // 长度说了算：长口令不需要大小写和符号混排（NIST SP 800-63B）
  test.each([
    ['correcthorsebatterystaple', 3],
    ['我的密码很长很长很长很长很长', 1],
    ['12345678901234567890', 3],
    ['aaaaaaaaaaaaaaaa', 2],
  ])('长口令 %s 是 %i 档，不因为只有一种字符就算弱', (password, level) => {
    expect(passwordStrength(password)).toBe(level)
  })

  // 常见的套路密码长度不够，不该到最高档
  test.each([
    ['Password123!', 2],
    ['Qwerty123456!', 2],
  ])('套路密码 %s 最多到「强」', (password, level) => {
    expect(passwordStrength(password)).toBe(level)
  })

  test.each([
    ['abc', 0],
    ['password', 1],
    ['1234567', 0],
    ['12345678', 1],
  ])('%s 是 %i 档', (password, level) => {
    expect(passwordStrength(password)).toBe(level)
  })

  // 长度不够时字符种类才加分
  test('同样 12 位，混排比单一字符高一档', () => {
    expect(passwordStrength('aaaaaaaaaaaa')).toBe(1)
    expect(passwordStrength('Aaaaaaa12345')).toBe(2)
  })

  test('按码点算长度，不按 UTF-16 码元', () => {
    expect(passwordStrength('🙂'.repeat(16))).toBe(2)
    expect(passwordStrength('🙂'.repeat(8))).toBe(1)
  })
})
