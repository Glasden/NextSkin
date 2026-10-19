/**
 * 作废一个用户还在途的登录（ADR-0036）。都在调用方的事务里执行，和改密码、删通行密钥、解绑放在一起提交。
 *
 * 依赖 Better Auth 写在 verifications 里的标识格式和值（docs/schema.md 的 verifications 一行），标识按明文存储
 * （`verification.storeIdentifier` 保持默认）。升级 Better Auth 时由"之前签发的找回链接返回 INVALID_TOKEN、
 * 之前的两步验证挑战无法完成"的测试守住
 */
import type { CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'

function assertTransaction(tx: Kysely<CoreDatabase>) {
  if (!tx.isTransaction) throw new TypeError('作废登录必须在调用方的事务中执行')
}

/** 删掉这个用户的全部启动器令牌，返回删掉的数量。经 Better Auth 改密码之后的单独事务也用它（core.ts） */
export async function deleteLauncherTokens(tx: Kysely<CoreDatabase>, uid: number): Promise<number> {
  const result = await tx.deleteFrom('yggdrasil_tokens').where('user_id', '=', uid).executeTakeFirst()
  return Number(result.numDeletedRows)
}

/** 删掉还没用的找回密码链接 `reset-password:<令牌>`（值是 uid）。邮箱改动生效时也调用：链接发到了旧地址 */
export async function deletePasswordResetLinks(tx: Kysely<CoreDatabase>, uid: number): Promise<void> {
  await tx
    .deleteFrom('verifications')
    .where('identifier', 'like', 'reset-password:%')
    .where('value', '=', String(uid))
    .execute()
}

/**
 * 删掉两步验证的挑战 `2fa-<随机>`（值是 uid），连同它的尝试计数 `2fa-attempts-2fa-<随机>`。
 * 尝试计数的值是次数，可能恰好等于某个 uid，所以按值找人时要排除它；`2fa-otp-` 是邮件验证码，这里没有启用
 */
export async function deleteTwoFactorChallenges(tx: Kysely<CoreDatabase>, uid: number): Promise<void> {
  const challenges = await tx
    .selectFrom('verifications')
    .select('identifier')
    .where('identifier', 'like', '2fa-%')
    .where('identifier', 'not like', '2fa-attempts-%')
    .where('identifier', 'not like', '2fa-otp-%')
    .where('value', '=', String(uid))
    .execute()
  const identifiers = challenges.flatMap(({ identifier }) => [identifier, `2fa-attempts-${identifier}`])
  if (identifiers.length) await tx.deleteFrom('verifications').where('identifier', 'in', identifiers).execute()
}

/** 删掉"信任这台设备"的记录 `trust-device-<随机>`（值是 uid）：关两步验证之后，旧设备要重新过第二步 */
export async function deleteTrustedDevices(tx: Kysely<CoreDatabase>, uid: number): Promise<void> {
  await tx
    .deleteFrom('verifications')
    .where('identifier', 'like', 'trust-device-%')
    .where('value', '=', String(uid))
    .execute()
}

export interface RevokedLogins {
  revokedSessions: number
  revokedTokens: number
}

/**
 * 作废在途的登录：全部网页会话（Better Auth 没有开会话缓存，删掉行下一次请求就失效）、全部启动器令牌、
 * 两步验证的挑战（它已经过了密码这一步）、找回密码链接，以及还没确认的改邮箱链接（`email_version` 加一，ADR-0024）。
 * 后台改密码（包括收回账号）、删通行密钥、解绑、退出全部登录和命令行的 set-password 共用。调用方已经锁住用户行
 */
export async function revokeLogins(tx: Kysely<CoreDatabase>, uid: number): Promise<RevokedLogins> {
  assertTransaction(tx)
  const sessions = await tx.deleteFrom('sessions').where('user_id', '=', uid).executeTakeFirst()
  const revokedTokens = await deleteLauncherTokens(tx, uid)
  await deleteTwoFactorChallenges(tx, uid)
  await deletePasswordResetLinks(tx, uid)
  await tx
    .updateTable('users')
    .set((eb) => ({ email_version: eb('email_version', '+', 1) }))
    .where('id', '=', uid)
    .execute()
  return { revokedSessions: Number(sessions.numDeletedRows), revokedTokens }
}
