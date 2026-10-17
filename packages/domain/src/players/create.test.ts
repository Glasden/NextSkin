import { expect, test } from 'vitest'
import { DomainError } from '../errors.ts'
import { offlineUuid, validatePlayerName, type PlayerNameSettings } from './create.ts'

const defaults: PlayerNameSettings = {
  'player.nameRule': 'official',
  'player.nameRegex': '',
  'player.nameLength': { min: 3, max: 16 },
}
const validate = (name: string, rule: PlayerNameSettings['player.nameRule'] = 'official', regex = '') =>
  validatePlayerName(name, { ...defaults, 'player.nameRule': rule, 'player.nameRegex': regex })

test('official、cjk 和 custom 与 BS 的规则一致，首尾空白先移除', () => {
  expect(validate('  Steve_42\n')).toBe('Steve_42')
  expect(validate('§一鿿A_9', 'cjk')).toBe('§一鿿A_9')
  expect(() => validate('中文名')).toThrow(
    expect.objectContaining({ code: 'player_name_invalid', params: { rule: 'official' } }),
  )
  expect(() => validate('𠀀中文', 'cjk')).toThrow(DomainError)
  expect(validate('ab🧑', 'custom')).toBe('ab🧑')
  expect(validate('abc', 'custom', '^abc$')).toBe('abc')
  expect(() => validate('abd', 'custom', '^abc$')).toThrow(expect.objectContaining({ code: 'player_name_invalid' }))
  expect(() => validate('abc', 'custom', '[')).toThrow(
    expect.objectContaining({ code: 'player_name_rule_misconfigured' }),
  )
})

test.each([
  ' ',
  '\t',
  '\n',
  '\r',
  '\v',
  '\f',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u2007',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
])('utf8 拒绝内部 Unicode 空白 %j', (space) => {
  expect(() => validate(`a${space}b`, 'utf8')).toThrow(expect.objectContaining({ code: 'player_name_invalid' }))
})

test('长度按码位而非 UTF-16 单元计', () => {
  expect(validate('😀😀😀', 'utf8')).toBe('😀😀😀')
  expect(() => validate('😀😀', 'utf8')).toThrow(
    expect.objectContaining({ code: 'player_name_length', params: { min: 3, max: 16 } }),
  )
  expect(validate('😀'.repeat(16), 'utf8')).toBe('😀'.repeat(16))
  expect(() => validate('😀'.repeat(17), 'utf8')).toThrow(DomainError)
})

test('离线 Notch UUID：公开离线服务器向量，存成无连字符的小写 hex', () => {
  // https://mcutility.cc/reference/minecraft-uuid-format/ 的 Offline UUID Examples：Notch。
  // 算法也与 BS 6.0.2 plugins/yggdrasil-api/src/Models/Profile.php::generateUuidV3 一致。
  expect(offlineUuid('Notch')).toBe('b50ad385829d3141a2167e7d7539ba7f')
  expect(offlineUuid('notch')).not.toBe(offlineUuid('Notch'))
})
