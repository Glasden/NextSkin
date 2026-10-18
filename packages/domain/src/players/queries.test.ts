import { expect, test } from 'vitest'
import { normalizeNameLookup, normalizeUuidLookup, toNameKey } from './queries.ts'

test('存储规范化只转小写，保留所有空白与 Unicode', () => {
  expect(toNameKey(' ALICE \t')).toBe(' alice \t')
  expect(toNameKey('İ角色')).toBe('i\u0307角色')
})

test.each([
  ['ALIce', 'alice'],
  ['Alice  ', 'alice'],
  [' Alice ', ' alice'],
  ['', null],
  ['   ', null],
  ['Dot.Name', 'dot.name'],
  ['Alice\t', 'alice\t'],
  ['Alice\u00a0', 'alice\u00a0'],
  // 角色名不会含 NUL，PostgreSQL 也放不进；直接当作查不到，不发查询
  ['Al\u0000ice', null],
])('名字查找 %j → %j', (name, expected) => {
  expect(normalizeNameLookup(name)).toBe(expected)
})

test.each([
  ['0123456789ABCDEF0123456789ABCDEF ', '0123456789abcdef0123456789abcdef'],
  ['01234567-89ab-cdef-0123-456789abcdef', null],
  ['a'.repeat(31), null],
  ['g'.repeat(32), null],
  [' ' + 'a'.repeat(32), null],
  ['a'.repeat(32) + '\t', null],
  ['', null],
])('UUID 查找 %j → %j', (uuid, expected) => {
  expect(normalizeUuidLookup(uuid)).toBe(expected)
})
