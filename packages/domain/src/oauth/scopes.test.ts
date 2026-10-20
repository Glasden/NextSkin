import { expect, test } from 'vitest'
import {
  isValidScopeSet,
  JOIN_SCOPE,
  parsePlayerReference,
  playerReference,
  READ_SCOPE,
  readScopes,
  SELECT_SCOPE,
  SHARED_CLIENT_SCOPES,
  splitScopes,
  userCodeCandidates,
} from './scopes.ts'

test('scope 的组合规则：Yggdrasil scope 要有 openid，Select 和 Read 互斥，Join 要有 Select', () => {
  expect(isValidScopeSet(['openid', 'offline_access', SELECT_SCOPE, JOIN_SCOPE])).toBe(true)
  expect(isValidScopeSet(['openid', READ_SCOPE])).toBe(true)
  expect(isValidScopeSet(['profile', 'email'])).toBe(true)
  expect(isValidScopeSet([])).toBe(true)
  expect(isValidScopeSet([SELECT_SCOPE])).toBe(false)
  expect(isValidScopeSet(['openid', SELECT_SCOPE, READ_SCOPE])).toBe(false)
  expect(isValidScopeSet(['openid', JOIN_SCOPE])).toBe(false)
  expect(isValidScopeSet(['openid', READ_SCOPE, JOIN_SCOPE])).toBe(false)
  expect(isValidScopeSet(['openid', 'Yggdrasil.MinecraftToken.Create'])).toBe(false)
  expect(isValidScopeSet(['openid', 'yggdrasil.server.join', SELECT_SCOPE])).toBe(false)
})

test('公用应用不能申请 email', () => {
  expect(SHARED_CLIENT_SCOPES).not.toContain('email')
  expect(SHARED_CLIENT_SCOPES).toEqual(expect.arrayContaining(['openid', 'offline_access', SELECT_SCOPE, JOIN_SCOPE]))
})

test('按空格拆 scope，去掉空串', () => {
  expect(splitScopes(`openid  ${SELECT_SCOPE} `)).toEqual(['openid', SELECT_SCOPE])
  expect(splitScopes(null)).toEqual([])
})

test('scopes 列：字符串和已解析的数组都认，坏值当作空', () => {
  expect(readScopes('["openid","profile"]')).toEqual(['openid', 'profile'])
  expect(readScopes(['openid', 1])).toEqual(['openid'])
  expect(readScopes('not json')).toEqual([])
  expect(readScopes(null)).toEqual([])
})

test('角色绑定严格解析', () => {
  expect(parsePlayerReference(playerReference(42))).toBe(42)
  for (const value of ['player:', 'player:0', 'player:05', 'player:1e3', 'player: 5', 'player:0x5', 'Player:5', null])
    expect(parsePlayerReference(value)).toBeNull()
  expect(parsePlayerReference('player:99999999999999999')).toBeNull()
})

test('用户代码按 Better Auth 的规则规范化', () => {
  expect(userCodeCandidates('ABCDEFGH')).toEqual(['ABCDEFGH'])
  expect(userCodeCandidates('abcd-efgh')).toEqual(['abcd-efgh', 'ABCDEFGH'])
  // 规范化之后有字符集外的字符（0、1、I、O）就不再查
  expect(userCodeCandidates('abcd-efg0')).toEqual(['abcd-efg0'])
})
