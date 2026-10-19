import type { CoreDatabase } from '@nextskin/db'
import { verifyPassword } from 'better-auth/crypto'
import type { Kysely } from 'kysely'
import { phpTrim } from '../text.ts'
import { MAX_PASSWORD_LENGTH } from './password-policy.ts'
import { isLegacyPasswordHash, verifyLegacyPassword } from './legacy-passwords.ts'

/** passwordHasher 插件（ADR-0033）：没有插件认领这个哈希、插件核对不通过或调用失败，都是 false */
export type PluginPasswordVerifier = (input: { hash: string; password: string }) => Promise<boolean>

export interface StoredPasswordCheck {
  /** BS 的全站盐，只有校验旧摘要格式的密码时才读 */
  legacySalt: () => Promise<string>
  /** 没有时（命令行脚本、测试）插件格式的哈希一律不通过 */
  plugins?: PluginPasswordVerifier
}

/** Better Auth 的 scrypt 哈希：16 字节盐和 64 字节密钥的十六进制，用冒号连接。NextSkin 自己设置的密码都是这种 */
export function isCurrentPasswordHash(hash: string): boolean {
  return /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash)
}

/**
 * 返回核对通过的明文，不通过返回 null。当前算法的哈希只按原值核对，在 NextSkin 设置的密码，首尾的空格是密码的一部分。
 * 其余的哈希都是从 BS 导入的：BS 的旧格式由核心核对，别的交给 passwordHasher 插件。它们按原值不通过、原值首尾又有
 * PHP trim() 去掉的字符时，再按 trim 之后的值核对：BS 的 TrimStrings 对网页登录同样生效，旧站的哈希是按 trim 之后的密码算的（ADR-0031）
 */
export async function matchStoredPassword(
  input: { hash: string; password: string },
  check: StoredPasswordCheck,
): Promise<string | null> {
  if (input.password.length > MAX_PASSWORD_LENGTH) return null
  // Better Auth 的 verifyPassword 遇到不是 scrypt 格式的值会抛错，别的格式不能交给它
  if (isCurrentPasswordHash(input.hash)) return (await verifyPassword(input)) ? input.password : null
  let verify: (password: string) => Promise<boolean>
  if (isLegacyPasswordHash(input.hash)) {
    const salt = await check.legacySalt()
    verify = (password) => verifyLegacyPassword({ hash: input.hash, password, salt })
  } else {
    const plugins = check.plugins
    if (!plugins) return null
    verify = (password) => plugins({ hash: input.hash, password })
  }
  if (await verify(input.password)) return input.password
  const trimmed = phpTrim(input.password)
  return trimmed !== input.password && (await verify(trimmed)) ? trimmed : null
}

/** 登录与敏感操作共用；只在旧格式需要时读取全站盐，不在这里重新哈希。 */
export async function verifyStoredPassword(
  input: { hash: string; password: string },
  check: StoredPasswordCheck,
): Promise<boolean> {
  return (await matchStoredPassword(input, check)) !== null
}

/**
 * 返回核对通过的那个哈希，不通过返回 null。核对很慢，调用方在事务外调用，锁住用户之后要确认密码还是这个哈希：
 * 后台改密码、收回账号可能恰好在这中间提交（ADR-0036"并发"）
 */
export async function checkUserPassword(
  db: Kysely<CoreDatabase>,
  uid: number,
  password: string,
  check: StoredPasswordCheck,
): Promise<string | null> {
  const account = await db
    .selectFrom('accounts')
    .select('password')
    .where('user_id', '=', uid)
    .where('provider_id', '=', 'credential')
    .executeTakeFirst()
  return account?.password && (await verifyStoredPassword({ hash: account.password, password }, check))
    ? account.password
    : null
}
