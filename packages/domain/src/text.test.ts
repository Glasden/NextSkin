import { expect, test } from 'vitest'
import { validatePlayerName } from './players/create.ts'
import { coreSettingsRegistry } from './settings/registry.ts'
import { validateTextureDescription, validateTextureName } from './textures/validation.ts'
import { validateNickname } from './users/validation.ts'
import { isStorageKey, phpTrim } from './text.ts'

// PostgreSQL 的 text 存不了 U+0000：用户填的文本在写库之前一律拒绝，四种数据库的结果才一致
test('用户填的文本里有 U+0000 时拒绝', () => {
  expect(() => validateNickname('Ste\u0000ve')).toThrow(expect.objectContaining({ code: 'invalid_request' }))
  expect(() => validateTextureName('Haka\u0000', '')).toThrow(expect.objectContaining({ code: 'texture_name_invalid' }))
  expect(() => validateTextureDescription('第一行\n\u0000')).toThrow(
    expect.objectContaining({ code: 'invalid_request' }),
  )
  const rules = {
    'player.nameRule': 'utf8',
    'player.nameRegex': '',
    'player.nameLength': coreSettingsRegistry['player.nameLength'].default,
  } as const
  expect(() => validatePlayerName('Ste\u0000ve', rules)).toThrow(
    expect.objectContaining({ code: 'player_name_invalid', params: { rule: 'utf8' } }),
  )
  expect(validatePlayerName('Steve§', rules)).toBe('Steve§')
})

test('phpTrim 只去掉 PHP trim() 默认的空白字符', () => {
  expect(phpTrim(' \t\n\r\0\x0BSteve \t\n\r\0\x0B')).toBe('Steve')
  expect(phpTrim('\u00a0Steve\u3000')).toBe('\u00a0Steve\u3000')
})

test('isStorageKey：码位计长，首尾空白、NUL、不成对的代理项都不行', () => {
  expect(isStorageKey('😀'.repeat(3), 3)).toBe(true)
  expect(isStorageKey('😀'.repeat(4), 3)).toBe(false)
  for (const key of ['', ' a', 'a ', '\ta', 'a\u0000b', '\ud800', 'a\udc00', '\udc00\ud800'])
    expect(isStorageKey(key, 255)).toBe(false)
})
