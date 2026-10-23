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

  // 占一半以上才算弱，只出现在一小部分里不算
  test.each([
    ['占三分之二', 'jingbing2024', 0],
    ['正好占一半', 'jingbingXk9#mQ2$', 0],
    ['只占三分之一', 'Xk9#mQ2$jingbing@wZ4!8pL', 3],
    ['占五分之二', 'Xk9#jingbing$mQ2vL8@', 3],
  ])('个人信息%s（%s）是第 %i 档', (_label, password, level) => {
    expect(passwordStrength(password, { usernames: ['jingbing'] })).toBe(level)
  })

  // 邮箱前缀和角色名常常是同一个词：steve 只占 12 位里的 5 位，不能因为出现在两处就数成 10 位
  test('同一个词出现在几处个人信息里只算一次', () => {
    expect(passwordStrength('steve7x$Q2k9', { usernames: ['steve'] })).toBe(2)
    expect(passwordStrength('steve7x$Q2k9', { usernames: ['steve@example.com', 'Steve', 'steve'] })).toBe(2)
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

  // 大小写字母各算一类：同样 12 个字符，多一个大写就从「一般」升到「强」
  test.each([
    ['小写加数字两类', 'qwmzrkfamz12', 1],
    ['再加一个大写就是三类', 'qwmzrkfamz1A', 2],
  ])('大小写各算一类：%s（%s）是第 %i 档', (_label, password, level) => {
    expect(passwordStrength(password)).toBe(level)
  })

  // 只有一种字符、但一个字符都不重复的随机串不算弱
  test.each([
    ['单一字符集不重复', 'qwmzrkfa', 1],
    ['全大写不重复', 'QWMZRKFA', 1],
    ['不重复的汉字', '汉字密码强度测试', 1],
    ['有重复就不算', 'qwmzrkfq', 0],
  ])('单一字符集：%s（%s）是第 %i 档', (_label, password, level) => {
    expect(passwordStrength(password)).toBe(level)
  })

  // 评审给的例子：长度说了算，套路密码不能算强
  test.each([
    ['口令短语算很强', 'correcthorsebatterystaple', 3],
    ['14 个字的中文口令不算弱', '我的密码很长很长很长很长很长', 1],
    ['常见口令加符号后缀不是强', 'Password123!', 0],
    ['键盘套路加数字不是强', 'Qwerty123456!', 0],
  ])('%s（%s）是第 %i 档', (_label, password, level) => {
    expect(passwordStrength(password)).toBe(level)
  })

  // 长度为主：字符种类只在长度不够时加分，没有结构的 16 位以上至少是强
  test.each([
    ['16 位单一小写', 'qwmzrkfbxvntpsdj', 2],
    ['17 位单一小写', 'zkqmxwfzrkvpmsdjw', 2],
    ['14 位两种字符', 'zkqmxwfzrkvpm1', 1],
    ['12 位一种字符', 'qwmzrkfambcd', 1],
  ])('长度为主：%s（%s）是第 %i 档', (_label, password, level) => {
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
    // 12 个 emoji 是 12 个码点、24 个 UTF-16 单元：只有一种字符，一个都不重复就不算弱
    expect(passwordStrength('😀😃😄😁😆😅😂🤣😊😇🙂🙃')).toBe(1)
    expect(passwordStrength('😀😃😄😁😆😅😂🤣')).toBe(1)
    // 重复的 emoji 还是弱
    expect(passwordStrength('😀😀😀😀😀😀😀😀😀😀😀😀')).toBe(0)
  })
})
