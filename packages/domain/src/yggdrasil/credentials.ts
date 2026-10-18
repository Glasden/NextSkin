import { createHmac, timingSafeEqual } from 'node:crypto'
import { readAuthBoolean, readAuthDate, toIsoTimestamp, writeAuthDate, type CoreDatabase } from '@nextskin/db'
import { hashPassword, symmetricDecrypt } from 'better-auth/crypto'
import { sql, type Kysely, type Selectable } from 'kysely'
import { z } from 'zod'
import { deriveSecret } from '../auth/auth.ts'
import { isLegacyPasswordHash } from '../auth/legacy-passwords.ts'
import { verifyStoredPassword } from '../auth/password.ts'
import { normalizeNameLookup } from '../players/queries.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { forbidden, YggdrasilError } from './errors.ts'
import { createLoginThrottle } from './throttle.ts'

export interface CredentialsInput {
  username: string | null
  password: string | null
  rawPassword: string | null
}

export function verifyTotp(secret: string, code: string, time: number): boolean {
  if (!/^\d{6}$/.test(code)) return false
  let matched = false
  for (let offset = -1; offset <= 1; offset++) {
    const counter = Buffer.alloc(8)
    counter.writeBigInt64BE(BigInt(Math.floor(time / 30_000) + offset))
    const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest()
    const start = digest[digest.length - 1]! & 15
    const expected = String((digest.readUInt32BE(start) & 0x7fffffff) % 1_000_000).padStart(6, '0')
    matched = timingSafeEqual(Buffer.from(code), Buffer.from(expected)) || matched
  }
  return matched
}

export function createCredentials(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  secretKey: string
  now: () => Date
}) {
  const { db, settings, now } = options
  const throttle = createLoginThrottle(now)
  const secret = deriveSecret(options.secretKey)
  const legacySalt = async () => (await settings.read(['auth.legacyPasswordSalt']))['auth.legacyPasswordSalt']

  /** 核对通过时返回这时库里的密码哈希（旧格式已经换成当前算法），签发令牌的事务用它确认密码没有被改过 */
  async function verify(user: Selectable<CoreDatabase['users']>, input: CredentialsInput): Promise<string | null> {
    const account = await db
      .selectFrom('accounts')
      .select(['id', 'password'])
      .where('user_id', '=', user.id)
      .where('provider_id', '=', 'credential')
      .executeTakeFirst()
    if (!account?.password) return null
    const factor = readAuthBoolean(user.two_factor_enabled ?? false)
      ? await db
          .selectFrom('two_factors')
          .selectAll()
          .where('user_id', '=', user.id)
          .where('verified', '=', true)
          .executeTakeFirst()
      : undefined
    const time = now().getTime()
    if (factor?.locked_until) {
      if (new Date(readAuthDate(factor.locked_until)).getTime() > time) return null
      await db
        .updateTable('two_factors')
        .set({ failed_verification_count: 0, locked_until: null })
        .where('id', '=', factor.id)
        .where('locked_until', '<=', writeAuthDate(db, toIsoTimestamp(now())))
        .execute()
    }
    const candidates = [input.password]
    if (input.rawPassword !== input.password) candidates.push(input.rawPassword)
    let accepted: { password: string; code: string } | undefined
    for (const candidate of candidates) {
      if (candidate === null) continue
      if (factor && !/\d{6}$/.test(candidate)) continue
      const password = factor ? candidate.slice(0, -6) : candidate
      if (await verifyStoredPassword({ hash: account.password, password }, legacySalt)) {
        accepted = { password, code: factor ? candidate.slice(-6) : '' }
        break
      }
    }
    if (!accepted) return null
    let current = account.password
    if (isLegacyPasswordHash(account.password)) {
      const hash = await hashPassword(accepted.password)
      const upgraded = await db
        .updateTable('accounts')
        .set({ password: hash })
        .where('id', '=', account.id)
        .where('password', '=', account.password)
        .executeTakeFirstOrThrow()
      // 没有更新到说明密码刚被改过，按核对不通过处理
      if (upgraded.numUpdatedRows !== 1n) return null
      current = hash
    }
    if (factor) {
      const key = await symmetricDecrypt({ key: secret, data: factor.secret })
      if (!verifyTotp(key, accepted.code, time)) {
        // 先原子累加，再带阈值条件锁定，避免 MySQL 的赋值顺序影响计数。
        await db
          .updateTable('two_factors')
          .set({ failed_verification_count: sql`coalesce(failed_verification_count, 0) + 1` })
          .where('id', '=', factor.id)
          .execute()
        await db
          .updateTable('two_factors')
          .set({ locked_until: writeAuthDate(db, toIsoTimestamp(new Date(time + 900_000))) })
          .where('id', '=', factor.id)
          .where('failed_verification_count', '>=', 10)
          .execute()
        return null
      }
      await db
        .updateTable('two_factors')
        .set({ failed_verification_count: 0, locked_until: null })
        .where('id', '=', factor.id)
        .execute()
    }
    return current
  }

  return async function credentials(input: CredentialsInput) {
    const values = await settings.read(['yggdrasil.loginIntervalMs'])
    throttle.interval(input.username, values['yggdrasil.loginIntervalMs'])
    if (input.username === null || input.password === null)
      throw new YggdrasilError('IllegalArgumentException', 'yggdrasil.errors.credentials_required')
    const email = z.email().safeParse(input.username).success ? input.username.toLowerCase() : null
    const name = normalizeNameLookup(input.username)
    const user =
      email !== null
        ? await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst()
        : await db
            .selectFrom('users')
            .innerJoin('players', 'players.user_id', 'users.id')
            .selectAll('users')
            .select('players.name_key')
            .where('players.name_key', '=', name ?? '')
            .executeTakeFirst()
    const found =
      user && (email !== null ? user.email === email : 'name_key' in user && user.name_key === name) ? user : null
    const key = found ? `uid:${found.id}` : `username:${input.username.toLowerCase()}`
    // 核对通过之前不用这个用户的界面语言：文案的语言也能说明账号是否存在
    throttle.assertAllowed(key, null)
    const passwordHash = found ? await verify(found, input) : null
    if (!found || passwordHash === null) {
      throttle.fail(key)
      throw forbidden('invalid_credentials')
    }
    return { user: found, passwordHash }
  }
}
