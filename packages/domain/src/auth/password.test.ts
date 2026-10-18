import { createHash } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { MAX_PASSWORD_LENGTH } from './password-policy.ts'
import { matchStoredPassword, verifyStoredPassword } from './password.ts'

const digest = (password: string) => `$bs$sha256$${createHash('sha256').update(password).digest('hex')}`

test('旧哈希先核对原值，再回退 PHP trim；两次核对只读一次盐', async () => {
  const salt = vi.fn(() => Promise.resolve('bs-salt'))
  const password = ' secret\t'
  expect(await matchStoredPassword({ hash: digest(password), password }, salt)).toBe(password)
  expect(salt).toHaveBeenCalledTimes(1)
  salt.mockClear()
  expect(await matchStoredPassword({ hash: digest('secret'), password }, salt)).toBe('secret')
  expect(salt).toHaveBeenCalledTimes(1)
})

test('空密码的匹配值仍算通过；不匹配返回 null', async () => {
  const salt = () => Promise.resolve('')
  expect(await matchStoredPassword({ hash: digest(''), password: ' \t' }, salt)).toBe('')
  expect(await verifyStoredPassword({ hash: digest(''), password: ' \t' }, salt)).toBe(true)
  expect(await matchStoredPassword({ hash: digest('secret'), password: 'wrong' }, salt)).toBeNull()
})

test('原值超长时不核对、不读盐，即使 trim 后不超长', async () => {
  const salt = vi.fn(() => Promise.resolve(''))
  expect(
    await matchStoredPassword({ hash: digest('secret'), password: 'secret' + ' '.repeat(MAX_PASSWORD_LENGTH) }, salt),
  ).toBeNull()
  expect(salt).not.toHaveBeenCalled()
})
