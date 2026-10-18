import { expect, test } from 'vitest'
import { translatePlugin } from './messages.ts'

const messages = {
  en: { greeting: 'Hello, {name}!', count: '{n, plural, one {# code} other {# codes}}', broken: '{missing}' },
  'zh-CN': { greeting: '你好，{name}！', only: { here: '后备文案' }, broken: '可以回退' },
}
const translate = (key: string, locale = 'en', params?: Record<string, string | number>) =>
  translatePlugin(messages, key, { locale, fallbackLocale: 'zh-CN', params })

test('ICU 参数和复数按请求语言展开', () => {
  expect(translate('greeting', 'en', { name: 'Alex' })).toBe('Hello, Alex!')
  expect(translate('count', 'en', { n: 1 })).toBe('1 code')
  expect(translate('count', 'en', { n: 2 })).toBe('2 codes')
})

test('缺语言、缺键或 ICU 失败都尝试后备语言', () => {
  expect(translate('greeting', 'fr', { name: 'Alex' })).toBe('你好，Alex！')
  expect(translate('only.here')).toBe('后备文案')
  expect(translate('broken')).toBe('可以回退')
})

test('所有语言都缺键则返回原始键名', () => {
  expect(translate('missing.key')).toBe('missing.key')
})
