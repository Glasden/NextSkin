import type { CoreDatabase } from '@nextskin/db'
import { verifyPassword } from 'better-auth/crypto'
import type { Kysely } from 'kysely'
import { MAX_PASSWORD_LENGTH } from './password-policy.ts'
import { isLegacyPasswordHash, verifyLegacyPassword } from './legacy-passwords.ts'

/** 登录与敏感操作共用；只在旧格式需要时读取全站盐，不在这里重新哈希。 */
export async function verifyStoredPassword(
  input: { hash: string; password: string },
  legacyPasswordSalt: () => Promise<string>,
): Promise<boolean> {
  if (input.password.length > MAX_PASSWORD_LENGTH) return false
  return isLegacyPasswordHash(input.hash)
    ? verifyLegacyPassword({ ...input, salt: await legacyPasswordSalt() })
    : verifyPassword(input)
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
