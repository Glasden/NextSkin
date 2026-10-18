import { readAuthDate, toIsoTimestamp, writeAuthDate } from '@nextskin/db'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { expect, test, vi } from 'vitest'
import { isLegacyPasswordHash } from '../auth/legacy-passwords.ts'
import { Browser, totp } from '../auth/security.test-helper.ts'
import { email, password, setup } from './yggdrasil.test-helper.ts'

const s = setup()
const invalid = {
  kind: 'ForbiddenOperationException',
  messageKey: 'yggdrasil.errors.invalid_credentials',
  // 核对通过之前不用用户的界面语言，免得文案的语言说明账号存在
  locale: null,
}
const tooMany = { messageKey: 'yggdrasil.errors.too_many_failures' }

async function enable() {
  const browser = new Browser(s.core)
  expect((await browser.request('/api/auth/sign-in/email', { email, password })).status).toBe(200)
  const response = await browser.request('/api/auth/two-factor/enable', { password })
  expect(response.status).toBe(200)
  const result = (await response.json()) as { totpURI: string; backupCodes: string[] }
  const secret = new URL(result.totpURI).searchParams.get('secret')!
  expect((await browser.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })).status).toBe(200)
  s.setTime(Date.now())
  return { browser, secret, backupCodes: result.backupCodes }
}
const factor = () => s.db().selectFrom('two_factors').selectAll().where('user_id', '=', s.uid).executeTakeFirstOrThrow()

test('缺少用户名或密码先返回 400；未知账号与密码错误共用文案和语言', async () => {
  for (const extra of [{ username: null }, { password: null }])
    await expect(s.login(extra)).rejects.toMatchObject({
      kind: 'IllegalArgumentException',
      messageKey: 'yggdrasil.errors.credentials_required',
      locale: null,
    })
  await expect(s.login({ username: 'unknown@example.test' })).rejects.toMatchObject(invalid)
  await expect(s.login({ password: 'wrong', rawPassword: 'wrong' })).rejects.toMatchObject(invalid)
  await s.player()
  await expect(s.login({ username: 'sTeVE   ', password: 'wrong', rawPassword: 'wrong' })).rejects.toMatchObject(
    invalid,
  )
  await s.login({ username: 'STEVE@NEXTSKIN.TEST' })
  await s.login({ username: 'sTeVE   ' })
})

test('旧 bcrypt 登录立即升级哈希；原值含空白时在 trim 密码失败后回退', async () => {
  const old = '$2y$10$rGpvsoGqqJj9Ahl6AnxY2uSd8VfK46pZU.MJKrw8/SYZwHn29jTB.'
  await s.db().updateTable('accounts').set({ password: old }).where('user_id', '=', s.uid).execute()
  await s.login({ password: 'php-era-password', rawPassword: ' php-era-password ' })
  const upgraded = await s
    .db()
    .selectFrom('accounts')
    .select('password')
    .where('user_id', '=', s.uid)
    .executeTakeFirstOrThrow()
  expect(isLegacyPasswordHash(upgraded.password!)).toBe(false)
  expect(await verifyPassword({ hash: upgraded.password!, password: 'php-era-password' })).toBe(true)
  const raw = '  raw password with spaces  '
  await s
    .db()
    .updateTable('accounts')
    .set({ password: await hashPassword(raw) })
    .where('user_id', '=', s.uid)
    .execute()
  await s.login({ password: raw.trim(), rawPassword: raw })
})

test('只有通行密钥或第三方登录、没有 credential 密码的用户无法登录', async () => {
  await s.db().deleteFrom('accounts').where('user_id', '=', s.uid).execute()
  await expect(s.login()).rejects.toMatchObject(invalid)
  await s
    .db()
    .insertInto('accounts')
    .values({
      account_id: 'external',
      provider_id: 'external',
      user_id: s.uid,
      password: await hashPassword(password),
      created_at: writeAuthDate(s.db(), toIsoTimestamp(s.now())),
      updated_at: writeAuthDate(s.db(), toIsoTimestamp(s.now())),
    })
    .execute()
  await expect(s.login()).rejects.toMatchObject(invalid)
})

test('间隔按用户名小写共用 authenticate 和 signout，拒绝不推进时间，0 不限', async () => {
  await s.setting('yggdrasil.loginIntervalMs', 1500)
  await s.login()
  s.tick(100)
  await expect(s.login({ username: email.toUpperCase() })).rejects.toMatchObject({
    messageKey: 'yggdrasil.errors.too_frequent',
    params: { seconds: 2 },
  })
  s.tick(400)
  await expect(s.core.yggdrasil.signout({ username: email, password, rawPassword: password })).rejects.toMatchObject({
    messageKey: 'yggdrasil.errors.too_frequent',
    params: { seconds: 1 },
  })
  s.tick(1000)
  await s.login()
  await s.setting('yggdrasil.loginIntervalMs', 0)
  await s.login()
  await s.login()
})

test('间隔检查先于必填检查，null 的用户名共用空字符串键', async () => {
  await s.setting('yggdrasil.loginIntervalMs', 1000)
  await expect(s.login({ username: null })).rejects.toMatchObject({
    messageKey: 'yggdrasil.errors.credentials_required',
  })
  await expect(s.login({ username: null })).rejects.toMatchObject({ messageKey: 'yggdrasil.errors.too_frequent' })
})

test('失败次数按 uid 合并邮箱和所有角色，成功不清零，固定窗口过后恢复', async () => {
  await s.player('First')
  await s.player('Second')
  for (const username of [email, 'First', 'second'])
    await expect(s.login({ username, password: 'wrong', rawPassword: 'wrong' })).rejects.toMatchObject(invalid)
  await s.login()
  s.tick(10 * 60_000)
  for (const username of ['FIRST', email.toUpperCase()])
    await expect(s.login({ username, password: 'wrong', rawPassword: 'wrong' })).rejects.toMatchObject(invalid)
  await expect(s.login({ username: 'Second' })).rejects.toMatchObject(tooMany)
  s.tick(5 * 60_000)
  await s.login()
})

test('找不到用户时按小写 username 累加，其他 username 不受影响', async () => {
  for (let i = 0; i < 5; i++)
    await expect(s.login({ username: i % 2 ? 'Ghost' : 'ghost' })).rejects.toMatchObject(invalid)
  await expect(s.login({ username: 'GHOST' })).rejects.toMatchObject(tooMany)
  await expect(s.login({ username: 'different' })).rejects.toMatchObject(invalid)
  await s.login()
  s.tick(900_000)
  await expect(s.login({ username: 'ghost' })).rejects.toMatchObject(invalid)
})

test('真实网页启用两步验证后密码接验证码能登录和退出；缺码、错码、过期码和备用码被拒绝', async () => {
  const { secret, backupCodes } = await enable()
  const correct = totp(secret)
  await s.login({ password: password + correct, rawPassword: password + correct })
  expect((await factor()).failed_verification_count).toBe(0)
  await expect(s.login()).rejects.toMatchObject(invalid)
  const wrong = correct === '000000' ? '000001' : '000000'
  await expect(s.login({ password: password + wrong, rawPassword: password + wrong })).rejects.toMatchObject(invalid)
  expect((await factor()).failed_verification_count).toBe(1)
  s.tick(90_000)
  await expect(s.login({ password: password + correct, rawPassword: password + correct })).rejects.toMatchObject(
    invalid,
  )
  expect((await factor()).failed_verification_count).toBe(2)
  s.setTime(Date.now())
  await expect(
    s.login({ password: password + backupCodes[0]!, rawPassword: password + backupCodes[0]! }),
  ).rejects.toMatchObject(invalid)
  await s.core.yggdrasil.signout({
    username: email,
    password: password + totp(secret),
    rawPassword: password + totp(secret),
  })
  expect(await s.core.yggdrasil.listTokens(s.uid)).toEqual([])
  expect((await factor()).failed_verification_count).toBe(0)
})

test('网页与启动器共用失败次数，第十次锁定，正确码在锁定期间也拒绝；到期清零恢复', async () => {
  const { browser, secret } = await enable()
  await browser.request('/api/auth/sign-out', {})
  const correct = totp(secret),
    wrong = correct === '000000' ? '000001' : '000000'
  // 网页先失败五次，启动器再失败五次，两个入口共用第十次锁定。
  expect((await browser.request('/api/auth/sign-in/email', { email, password })).status).toBe(200)
  for (let i = 0; i < 5; i++)
    expect((await browser.request('/api/auth/two-factor/verify-totp', { code: wrong })).status).toBe(401)
  expect((await factor()).failed_verification_count).toBe(5)
  for (let i = 0; i < 5; i++)
    await expect(s.login({ password: password + wrong, rawPassword: password + wrong })).rejects.toMatchObject(invalid)
  const locked = await factor()
  expect(locked.failed_verification_count).toBe(10)
  expect(new Date(readAuthDate(locked.locked_until)).getTime()).toBe(s.now().getTime() + 900_000)
  // 换核心实例只清内存限速，数据库里的两步验证锁仍然生效。
  const another = s.makeCore()
  await expect(
    s.login({ password: password + correct, rawPassword: password + correct }, another),
  ).rejects.toMatchObject(invalid)
  expect((await factor()).failed_verification_count).toBe(10)
  const freshBrowser = new Browser(s.core)
  expect((await freshBrowser.request('/api/auth/sign-in/email', { email, password })).status).toBe(200)
  expect((await freshBrowser.request('/api/auth/two-factor/verify-totp', { code: correct })).status).toBe(429)
  // Better Auth 用真实时间；领域时钟直接推进到数据库锁的截止点。
  s.tick(900_000)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(s.now().getTime())
  const codeAtExpiry = totp(secret)
  clock.mockRestore()
  await s.login({ password: password + codeAtExpiry, rawPassword: password + codeAtExpiry }, another)
  expect((await factor()).failed_verification_count).toBe(0)
  expect((await factor()).locked_until).toBeNull()
  expect((await freshBrowser.request('/api/auth/two-factor/verify-totp', { code: totp(secret) })).status).toBe(200)
})

test('真实网页密钥兼容前后各一个周期；连续失败计数为 null 时也原子累加', async () => {
  const { secret } = await enable()
  for (const offset of [-30_000, 30_000]) {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(s.now().getTime() + offset)
    const code = totp(secret)
    clock.mockRestore()
    await s.login({ password: password + code, rawPassword: password + code })
  }
  await s
    .db()
    .updateTable('two_factors')
    .set({ failed_verification_count: null })
    .where('user_id', '=', s.uid)
    .execute()
  const code = totp(secret) === '000000' ? '000001' : '000000'
  const attempts = await Promise.all(
    [0, 1].map(() =>
      s.login({ password: password + code, rawPassword: password + code }).then(
        () => null,
        (error: unknown) => error,
      ),
    ),
  )
  expect(attempts).toEqual([expect.objectContaining(invalid), expect.objectContaining(invalid)])
  expect((await factor()).failed_verification_count).toBe(2)
})

test('两步验证下旧哈希按 PHP trim 回退，升级只使用核对通过的密码，不含验证码', async () => {
  const { secret } = await enable()
  const old = '$2y$10$rGpvsoGqqJj9Ahl6AnxY2uSd8VfK46pZU.MJKrw8/SYZwHn29jTB.'
  await s.db().updateTable('accounts').set({ password: old }).where('user_id', '=', s.uid).execute()
  const value = ' php-era-password\t' + totp(secret)
  await s.login({ password: value, rawPassword: value })
  const account = await s
    .db()
    .selectFrom('accounts')
    .select('password')
    .where('user_id', '=', s.uid)
    .executeTakeFirstOrThrow()
  expect(isLegacyPasswordHash(account.password!)).toBe(false)
  expect(await verifyPassword({ hash: account.password!, password: 'php-era-password' })).toBe(true)
  expect(await verifyPassword({ hash: account.password!, password: value })).toBe(false)
})
