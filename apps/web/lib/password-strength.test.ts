import { describe, expect, test } from 'vitest'
import { passwordStrength } from './password-strength'

describe('passwordStrength', () => {
  test('没输入时不显示', () => {
    expect(passwordStrength('')).toBeNull()
  })

  // 硬弱规则：命中任一就是弱，不管有多长
  test.each([
    ['太短', 'Ab1!x'],
    ['纯数字', '284691375'],
    ['纯数字再长也是弱', '12345678901234567890'],
    ['常见弱口令', 'password'],
    ['常见弱口令加后缀', 'password123!'],
    ['leet 变形', 'P@ssw0rd'],
    ['键盘套路', 'qwerty'],
    ['国内常见', 'woaini1314'],
    ['同一个字符重复', 'aaaaaaaaaaaa'],
    ['重复单元', 'abcabcabcabc'],
    ['连续数字', '0123456789'],
    ['几乎全是键盘序列', 'qwerty123456'],
  ])('%s：%s 是弱', (_label, password) => {
    expect(passwordStrength(password)).toBe(0)
  })

  // 个人信息：登录名、角色名、昵称、邮箱里的词都不该出现在密码里
  test.each([
    ['登录名', 'jingbing', { usernames: ['jingbing'] }],
    ['登录名加数字后缀', 'jingbing2024', { usernames: ['jingbing'] }],
    ['大小写不同', 'JingBing!x', { usernames: ['jingbing'] }],
    ['昵称', 'steve2024!', { usernames: [undefined, 'Steve'] }],
    ['邮箱前缀', 'jingbingx2024!', { usernames: ['jingbing.x@example.com'] }],
  ])('%s出现在密码里就算弱', (_label, password, context) => {
    expect(passwordStrength(password, context)).toBe(0)
  })

  test('不相关的词不影响分档', () => {
    expect(passwordStrength('Tr0ub4dor&3', { usernames: ['jingbing'] })).toBe(2)
  })

  // 长度 + 字符种类 + 多样性分档
  test.each([
    ['短一点但有两种字符', 'abc12345', 1],
    ['绝大多数字符都不一样', 'x7#Kq2!m', 1],
    ['12 个字符的中文口令', '我的密码是这只猫的名字呀', 1],
    ['12 位三种字符', 'Xk9mQ2vL8pZa', 2],
    ['10 位四种字符', 'Xk9#mQ2$vL', 2],
    ['16 位四种字符', 'Xk9#mQ2$vL8@wZ4!', 3],
    ['14 位三种字符', 'Xk9mQ2vL8pZ3rT', 3],
    ['20 位三种字符', 'Xk9mQ2vL8pZ3rT7wB5n', 3],
    // 长口令短语：NIST SP 800-63B 认可这种，只有一种字符也算强
    ['口令短语', 'correcthorsebatterystaple', 3],
    ['20 个字符的中文短语', '我的密码是我家这只猫的名字以及它的生日呀', 3],
  ])('%s（%s）是第 %i 档', (_label, password, level) => {
    expect(passwordStrength(password)).toBe(level)
  })

  // 大小写字母各算一类：同样 8 个字符，多一个大写就从「弱」升到「一般」
  test.each([
    ['全小写', 'qwmzrkfa', 0],
    ['多一个大写', 'qwmzrkfA', 1],
    ['全大写', 'QWMZRKFA', 0],
    ['全大写加数字', 'QWMZRKF1', 1],
  ])('大小写各算一类：%s（%s）是第 %i 档', (_label, password, level) => {
    expect(passwordStrength(password)).toBe(level)
  })

  // 非 ASCII 的字符各算各的种类：汉字、假名、谚文、emoji 都不并进拉丁字母或符号
  test.each([
    ['只有汉字', '汉字汉字汉字汉字', 0],
    ['汉字加假名', '汉字汉字汉字かな', 1],
    ['汉字加 emoji 和数字', '汉字汉字汉字😀1', 1],
    ['谚文加数字', '한글한글한글한글1', 1],
    ['只有西里尔字母', 'ПарольПароль', 1],
    // 汉字、假名、拉丁小写、数字：四种字符，10 位就够强
    ['四种文字混排', '漢字かなカナabc1', 2],
    ['全角大写字母', 'ＡＢＣＤＥＦＧＨ', 0],
  ])('字符种类按文字分开：%s（%s）是第 %i 档', (_label, password, level) => {
    expect(passwordStrength(password)).toBe(level)
  })

  test('有结构的长密码进不了强和极强', () => {
    expect(passwordStrength('Abcdefghijkl')).toBeLessThanOrEqual(1)
    expect(passwordStrength('Qwertyuiop12')).toBeLessThanOrEqual(1)
  })

  test('emoji 按码点算长度', () => {
    // 12 个 emoji 是 12 个码点、24 个 UTF-16 单元：只有一种字符，够长才给「一般」
    expect(passwordStrength('😀😃😄😁😆😅😂🤣😊😇🙂🙃')).toBe(1)
    expect(passwordStrength('😀😃😄😁😆😅😂🤣')).toBe(0)
  })
})
