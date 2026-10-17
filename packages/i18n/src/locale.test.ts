import { describe, expect, test } from 'vitest'
import { createTranslator, matchAcceptLanguage, matchLocale, resolveLocale } from './index.ts'

describe('matchLocale', () => {
  test.each([
    ['zh-CN', 'zh-CN'],
    ['zh-cn', 'zh-CN'],
    ['zh', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['zh-Hant-HK', 'zh-CN'],
    ['en', 'en'],
    ['en-US', 'en'],
    [' EN-gb ', 'en'],
    ['ja', null],
    ['', null],
  ])('%s → %s', (tag, expected) => {
    expect(matchLocale(tag)).toBe(expected)
  })
})

describe('matchAcceptLanguage', () => {
  test('按 q 值取第一个受支持的语言', () => {
    expect(matchAcceptLanguage('ja;q=0.9, en;q=0.8, zh-CN;q=0.7')).toBe('en')
    expect(matchAcceptLanguage('en;q=0.5, zh-TW')).toBe('zh-CN')
  })

  test('q 相同时按出现的顺序', () => {
    expect(matchAcceptLanguage('en-US, zh-CN')).toBe('en')
  })

  test('忽略 *、q=0 和对应不上的语言', () => {
    expect(matchAcceptLanguage('*, en;q=0, ja')).toBeNull()
    expect(matchAcceptLanguage('')).toBeNull()
  })
})

describe('resolveLocale', () => {
  const header = 'en-US,en;q=0.9'

  test('用户设置优先，其次 Cookie、Accept-Language、站点默认', () => {
    expect(resolveLocale({ user: 'zh-CN', cookie: 'en', acceptLanguage: header, siteDefault: 'en' })).toBe('zh-CN')
    expect(resolveLocale({ user: null, cookie: 'zh-CN', acceptLanguage: header, siteDefault: 'en' })).toBe('zh-CN')
    expect(resolveLocale({ acceptLanguage: header, siteDefault: 'zh-CN' })).toBe('en')
    expect(resolveLocale({ acceptLanguage: 'ja', siteDefault: 'en' })).toBe('en')
  })

  test('无法识别的值跳过，不会让解析失败', () => {
    expect(resolveLocale({ user: 'klingon', cookie: '../../etc', siteDefault: 'zh-CN' })).toBe('zh-CN')
  })
})

test('翻译函数按 ICU 处理复数', () => {
  expect(createTranslator('en')('mail.verifyEmail.body', { hours: 1 })).toContain('1 hour.')
  expect(createTranslator('en')('mail.verifyEmail.body', { hours: 24 })).toContain('24 hours.')
  expect(createTranslator('zh-CN')('mail.verifyEmail.body', { hours: 1 })).toContain('1 小时内有效')
})
