import { expect, test } from 'vitest'
import { compareVersions, isValidRange, isValidVersion, parseVersion, satisfies } from './semver.ts'

test('semver 解析、构建元数据和预发布优先级', () => {
  expect(parseVersion('1.2.3-alpha.1+build.2')).toEqual({
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ['alpha', '1'],
    build: ['build', '2'],
  })
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '2.0.0',
  ]
  ordered.slice(1).forEach((v, i) => expect(compareVersions(ordered[i]!, v)).toBe(-1))
  expect(compareVersions('1.2.3+one', '1.2.3+two')).toBe(0)
  expect(compareVersions('1.0.0-99999999999999999999', '1.0.0-100000000000000000000')).toBe(-1)
  expect(() => compareVersions('invalid', '1.0.0')).toThrow()
})

test.each(['01.2.3', '1.2', '1.2.3-01', '1.2.3-a..b', '1.2.3+', '1.2.3-', 'v1.2.3', '9007199254740992.0.0', ' 1.2.3'])(
  '拒绝非法版本 %s',
  (v) => expect(isValidVersion(v)).toBe(false),
)

test.each([
  ['1.2.3', '1.2.3', true],
  ['1.2.3+build', '=1.2.3', true],
  ['1.2.4', '> 1.2.3', true],
  ['1.2.3', '>=1.2.3 <=1.2.3', true],
  ['1.2.3', '<1.2.3', false],
  ['1.2.3', '>1.2.3', false],
  ['1.9.0', '^1.2.3', true],
  ['2.0.0', '^1.2.3', false],
  ['0.2.9', '^0.2.3', true],
  ['0.3.0', '^0.2.3', false],
  ['0.0.4', '^0.0.3', false],
  ['0.0.3', '^0.0.3', true],
  ['0.9.0', '^0', true],
  ['0.2.9', '^0.2', true],
  ['1.2.9', '~1.2.3', true],
  ['1.3.0', '~1.2.3', false],
  ['1.9.0', '~1', true],
  ['8.0.0', '*', true],
  ['1.2.9', '1.2.x', true],
  ['1.3.0', '1.2.*', false],
  ['1.9.0', '1.x', true],
  ['1.2.3', '2.x || >=1.0.0 <1.5.0', true],
  ['1.8.0', '2.x || >=1.0.0 <1.5.0', false],
  ['1.3.0', '>1.2', true],
  ['1.2.3', '>1.2', false],
  ['1.2.9', '<=1.2', true],
  ['1.2.0', '<1.2', false],
  ['1.2.3-beta.2', '^1.2.3-beta.1', true],
  ['1.3.0-beta.1', '^1.2.3-beta.1', false],
  ['1.2.3-beta.1', '*', false],
  ['1.2.3-beta.1', '>=1.0.0', false],
  ['1.2.3-beta.1', '1.2.3-beta.1 || 2.x', true],
  ['1.2.3-beta.1', '>=1.2.3-beta.0 <2.0.0', true],
  ['2.0.0-beta', '^1.2.3-beta.1', false],
  ['1.2.3-beta', '^1.2.3-beta || *', true],
  ['1.2.3-beta', '>=1.2.3 || <2.0.0-beta', false],
] as const)('%s 满足 %s：%s', (version, range, expected) => {
  expect(isValidRange(range)).toBe(true)
  expect(satisfies(version, range)).toBe(expected)
})

test.each(['', 'wat', '1..2', '1.2.03', '1.x.3', '1.2.3 ||', '>=', '!=1.2.3', '1.2.3 - 2.0.0', '1.2.3.4'])(
  '拒绝非法范围 %s',
  (range) => {
    expect(isValidRange(range)).toBe(false)
    expect(satisfies('1.2.3', range)).toBe(false)
  },
)
