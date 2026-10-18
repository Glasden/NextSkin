import { expect, test } from 'vitest'
import { validatePlayerName } from './players/create.ts'
import { coreSettingsRegistry } from './settings/registry.ts'
import { validateTextureDescription, validateTextureName } from './textures/validation.ts'
import { validateNickname } from './users/validation.ts'

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
