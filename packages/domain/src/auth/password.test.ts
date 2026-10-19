import { createHash } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { expect, test, vi } from 'vitest'
import { MAX_PASSWORD_LENGTH } from './password-policy.ts'
import { isCurrentPasswordHash, matchStoredPassword, verifyStoredPassword } from './password.ts'

const digest = (password: string) => `$bs$sha256$${createHash('sha256').update(password).digest('hex')}`

test('旧哈希先核对原值，再回退 PHP trim；两次核对只读一次盐', async () => {
  const legacySalt = vi.fn(() => Promise.resolve('bs-salt'))
  const password = ' secret\t'
  expect(await matchStoredPassword({ hash: digest(password), password }, { legacySalt })).toBe(password)
  expect(legacySalt).toHaveBeenCalledTimes(1)
  legacySalt.mockClear()
  expect(await matchStoredPassword({ hash: digest('secret'), password }, { legacySalt })).toBe('secret')
  expect(legacySalt).toHaveBeenCalledTimes(1)
})

test('空密码的匹配值仍算通过；不匹配返回 null', async () => {
  const check = { legacySalt: () => Promise.resolve('') }
  expect(await matchStoredPassword({ hash: digest(''), password: ' \t' }, check)).toBe('')
  expect(await verifyStoredPassword({ hash: digest(''), password: ' \t' }, check)).toBe(true)
  expect(await matchStoredPassword({ hash: digest('secret'), password: 'wrong' }, check)).toBeNull()
})

test('原值超长时不核对、不读盐，即使 trim 后不超长', async () => {
  const legacySalt = vi.fn(() => Promise.resolve(''))
  const plugins = vi.fn(() => Promise.resolve(true))
  for (const hash of [digest('secret'), '$SHA$salt$digest'])
    expect(
      await matchStoredPassword(
        { hash, password: 'secret' + ' '.repeat(MAX_PASSWORD_LENGTH) },
        { legacySalt, plugins },
      ),
    ).toBeNull()
  expect(legacySalt).not.toHaveBeenCalled()
  expect(plugins).not.toHaveBeenCalled()
})

test('Better Auth 生成的哈希算当前算法', async () => {
  expect(isCurrentPasswordHash(await hashPassword('secret'))).toBe(true)
  expect(isCurrentPasswordHash(digest('secret'))).toBe(false)
  expect(isCurrentPasswordHash('$SHA$salt$digest')).toBe(false)
})

test('当前算法和 BS 旧格式之外的哈希交给插件；插件同样有 trim 回退，不读盐', async () => {
  const legacySalt = vi.fn(() => Promise.resolve(''))
  const plugins = vi.fn(({ password }: { hash: string; password: string }) => Promise.resolve(password === 'secret'))
  const hash = '$SHA$salt$digest'
  expect(await matchStoredPassword({ hash, password: 'secret' }, { legacySalt, plugins })).toBe('secret')
  expect(plugins).toHaveBeenLastCalledWith({ hash, password: 'secret' })
  plugins.mockClear()
  expect(await matchStoredPassword({ hash, password: ' secret\t' }, { legacySalt, plugins })).toBe('secret')
  expect(plugins.mock.calls.map(([input]) => input.password)).toEqual([' secret\t', 'secret'])
  plugins.mockClear()
  // 原值没有首尾空白就不再调用第二次
  expect(await matchStoredPassword({ hash, password: 'wrong' }, { legacySalt, plugins })).toBeNull()
  expect(plugins).toHaveBeenCalledTimes(1)
  expect(legacySalt).not.toHaveBeenCalled()
})

test('当前算法和旧格式的哈希不交给插件；没有插件时其余的哈希一律不通过，不抛错', async () => {
  const plugins = vi.fn(() => Promise.resolve(true))
  const legacySalt = () => Promise.resolve('')
  const current = await hashPassword('secret')
  expect(await matchStoredPassword({ hash: current, password: 'wrong' }, { legacySalt, plugins })).toBeNull()
  expect(await matchStoredPassword({ hash: digest('secret'), password: 'wrong' }, { legacySalt, plugins })).toBeNull()
  expect(plugins).not.toHaveBeenCalled()
  // Better Auth 的 verifyPassword 遇到不带冒号的值会抛错：这些值不能交给它
  for (const hash of ['$SHA$salt$digest', 'not-a-hash', 'a:b', ''])
    expect(await matchStoredPassword({ hash, password: 'secret' }, { legacySalt })).toBeNull()
})
