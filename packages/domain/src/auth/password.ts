import type { CoreDatabase } from '@nextskin/db'
import { verifyPassword } from 'better-auth/crypto'
import type { Kysely } from 'kysely'
import { phpTrim } from '../text.ts'
import { MAX_PASSWORD_LENGTH } from './password-policy.ts'
import { isLegacyPasswordHash, verifyLegacyPassword } from './legacy-passwords.ts'

/**
 * 返回核对通过的明文，不通过返回 null。旧格式的哈希按原值不通过、原值首尾又有 PHP trim() 去掉的字符时，
 * 再按 trim 之后的值核对：BS 的 TrimStrings 对网页登录同样生效，旧站的哈希是按 trim 之后的密码算的（ADR-0031）。
 * 当前算法的哈希只按原值核对，在 NextSkin 设置的密码，首尾的空格是密码的一部分
 */
export async function matchStoredPassword(
  input: { hash: string; password: string },
  legacyPasswordSalt: () => Promise<string>,
): Promise<string | null> {
  if (input.password.length > MAX_PASSWORD_LENGTH) return null
  if (!isLegacyPasswordHash(input.hash)) return (await verifyPassword(input)) ? input.password : null
  const salt = await legacyPasswordSalt()
  if (await verifyLegacyPassword({ ...input, salt })) return input.password
  const trimmed = phpTrim(input.password)
  return trimmed !== input.password && (await verifyLegacyPassword({ ...input, password: trimmed, salt }))
    ? trimmed
    : null
}

/** 登录与敏感操作共用；只在旧格式需要时读取全站盐，不在这里重新哈希。 */
export async function verifyStoredPassword(
  input: { hash: string; password: string },
  legacyPasswordSalt: () => Promise<string>,
): Promise<boolean> {
  return (await matchStoredPassword(input, legacyPasswordSalt)) !== null
}

export async function checkUserPassword(
  db: Kysely<CoreDatabase>,
  uid: number,
  password: string,
  legacyPasswordSalt: () => Promise<string>,
): Promise<boolean> {
  const account = await db
    .selectFrom('accounts')
    .select('password')
    .where('user_id', '=', uid)
    .where('provider_id', '=', 'credential')
    .executeTakeFirst()
  return !!account?.password && verifyStoredPassword({ hash: account.password, password }, legacyPasswordSalt)
}
