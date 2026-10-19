// users → users、accounts（docs/schema.md 的对照表）。头像要等材质导入之后再补（fillAvatars）
import { countRows, writeAuthDate, type UserRole } from '@nextskin/db'
import {
  authmeSaltedAlgorithm,
  formatAuthmeSalted,
  formatLegacyDigest,
  isCurrentPasswordHash,
  isLegacyPasswordHash,
  legacyDigestAlgorithm,
  matchLocale,
  type AuthmeSaltedAlgorithm,
  type LegacyDigestAlgorithm,
} from '@nextskin/domain/importer'
import { sql } from 'kysely'
import { chunks, importedTextures, MAX_ID, pages, type StageContext } from '../context.ts'
import { addBlocking, bump, LIST_LIMIT } from '../report.ts'
import { bsDateTime, toFlag, toInt, toText } from '../values.ts'

const ROLES: Record<number, UserRole> = { [-1]: 'banned', 0: 'user', 1: 'admin', 2: 'superadmin' }

export interface PasswordFormat {
  /** null：bcrypt、argon2，原样保存；否则是十六进制摘要的算法 */
  digest: LegacyDigestAlgorithm | null
  authmeSalted: AuthmeSaltedAlgorithm | null
  /** PWD_METHOD 是否来自旧站的 .env；没有时按 BS 的默认 BCRYPT */
  fromEnv: boolean
}

export function passwordFormat(pwdMethod: string | null): PasswordFormat {
  return {
    digest: legacyDigestAlgorithm(pwdMethod ?? 'BCRYPT'),
    authmeSalted: authmeSaltedAlgorithm(pwdMethod),
    fromEnv: pwdMethod !== null,
  }
}

type Converted =
  | { hash: string; reason?: 'authme_password' | 'plugin_password' }
  | { hash: null; reason: 'unrecognized' | 'needs_env' }

function convertPassword(stored: string, format: PasswordFormat, salt: string | null): Converted {
  if (/^\$2[aby]\$/.test(stored) || /^\$argon2(?:i|id)\$/.test(stored)) return { hash: stored }
  if (/^[0-9a-fA-F]+$/.test(stored)) {
    if (format.authmeSalted && salt) {
      try {
        return { hash: formatAuthmeSalted(format.authmeSalted, salt, stored), reason: 'authme_password' }
      } catch {
        return { hash: null, reason: 'unrecognized' }
      }
    }
    if (format.digest) {
      try {
        const hash = formatLegacyDigest(format.digest, stored)
        if (isLegacyPasswordHash(hash)) return { hash }
      } catch {
        // 长度和算法对不上：BS 自己也核对不了
      }
      return { hash: null, reason: 'unrecognized' }
    }
    // 不知道是哪种摘要就导入，这些用户全都登录不了（ADR-0031）
    return format.fromEnv ? { hash: null, reason: 'unrecognized' } : { hash: null, reason: 'needs_env' }
  }
  // 别的看起来像哈希的值原样保存，留给 passwordHasher 插件认领（ADR-0033）；$bs$、$authme$ 是 NextSkin 自己的格式，不会来自 BS
  if (
    /^[\x21-\x7e]{8,255}$/.test(stored) &&
    !stored.startsWith('$bs$') &&
    !stored.startsWith('$authme$') &&
    !isCurrentPasswordHash(stored)
  )
    return { hash: stored, reason: stored.startsWith('$SHA$') ? 'authme_password' : 'plugin_password' }
  return { hash: null, reason: 'unrecognized' }
}

export async function importUsers(ctx: StageContext, format: PasswordFormat): Promise<void> {
  const { src, tx, report } = ctx
  const stats = report.tables.users
  const table = ctx.schema.tables.users
  const readSalt = format.authmeSalted !== null && ctx.schema.userSalt
  stats.source = await countRows(src.selectFrom(table))
  ctx.advance('users', 0, undefined, stats.source)
  const emails = new Map<string, number>()
  const duplicates = new Map<string, number[]>()
  const needsEnv: number[] = []
  let needsEnvTotal = 0
  for await (const rows of pages(src, table, 'uid', [
    'uid',
    'email',
    'nickname',
    'locale',
    'score',
    'password',
    'ip',
    'permission',
    'last_sign_at',
    'register_at',
    'verified',
    ...(readSalt ? ['salt'] : []),
  ])) {
    const users = []
    const accounts = []
    for (const row of rows) {
      const uid = toInt(row.uid)!
      if (uid > MAX_ID) continue
      const email = (toText(row.email) ?? '').trim().toLowerCase()
      const first = emails.get(email)
      if (first !== undefined) {
        const list = duplicates.get(email) ?? [first]
        list.push(uid)
        duplicates.set(email, list)
        bump(stats.skipped, 'duplicate_email')
        continue
      }
      emails.set(email, uid)
      const permission = toInt(row.permission)
      let role = permission === null ? undefined : ROLES[permission]
      if (!role) {
        role = 'user'
        bump(stats.adjusted, 'unknown_permission')
      }
      let registeredAt = bsDateTime(row.register_at, ctx.timeZone)
      if (!registeredAt) {
        registeredAt = ctx.now
        bump(stats.adjusted, 'invalid_register_at')
      }
      const rawLocale = toText(row.locale)
      const locale = rawLocale ? matchLocale(rawLocale.replaceAll('_', '-')) : null
      if (rawLocale && !locale) bump(stats.adjusted, 'unsupported_locale')
      const ip = toText(row.ip)?.trim() || null
      users.push({
        id: uid,
        nickname: toText(row.nickname) ?? '',
        email,
        email_verified: toFlag(row.verified),
        created_at: writeAuthDate(tx, registeredAt),
        updated_at: writeAuthDate(tx, registeredAt),
        role,
        score: Math.max(-MAX_ID, Math.min(MAX_ID, toInt(row.score) ?? 0)),
        locale,
        registration_ip: ip && ip.length <= 45 ? ip : null,
        last_check_in_at: bsDateTime(row.last_sign_at, ctx.timeZone),
      })
      const converted = convertPassword(toText(row.password) ?? '', format, readSalt ? toText(row.salt) : null)
      if (converted.hash === null) {
        if (converted.reason === 'needs_env') {
          needsEnvTotal++
          if (needsEnv.length < LIST_LIMIT) needsEnv.push(uid)
        } else bump(stats.adjusted, 'unrecognized_password')
        continue
      }
      if (converted.reason) bump(stats.adjusted, converted.reason)
      // Better Auth 按 account_id 找密码，写 uid 的字符串
      accounts.push({
        account_id: String(uid),
        provider_id: 'credential',
        user_id: uid,
        password: converted.hash,
        created_at: writeAuthDate(tx, registeredAt),
        updated_at: writeAuthDate(tx, registeredAt),
      })
    }
    for (const part of chunks(users, 200)) await tx.insertInto('users').values(part).execute()
    for (const part of chunks(accounts, 200)) await tx.insertInto('accounts').values(part).execute()
    stats.imported += users.length
    ctx.advance('users', rows.length)
  }
  for (const [email, uids] of duplicates) addBlocking(report, { code: 'duplicate_email', email, uids })
  if (needsEnvTotal) addBlocking(report, { code: 'password_method_required', uids: needsEnv, total: needsEnvTotal })
}

/** 头像指向的材质导入了才保留；0、材质不存在或被跳过时为空 */
export async function fillAvatars(ctx: StageContext): Promise<void> {
  const { src, tx } = ctx
  for await (const rows of pages(src, ctx.schema.tables.users, 'uid', ['uid', 'avatar'])) {
    const wanted = rows
      .map((row) => ({ uid: toInt(row.uid)!, tid: toInt(row.avatar) ?? 0 }))
      .filter((row) => row.tid > 0 && row.uid <= MAX_ID)
    if (!wanted.length) continue
    const textures = await importedTextures(
      tx,
      wanted.map((row) => row.tid),
    )
    const found = wanted.filter((row) => textures.has(row.tid))
    if (found.length < wanted.length)
      bump(ctx.report.tables.users.adjusted, 'avatar_missing', wanted.length - found.length)
    for (const part of chunks(found, 200)) {
      if (!part.length) continue
      // 两个值都是校验过的整数，写成字面量：PostgreSQL 推断不出参数化的 case 分支的类型
      const cases = sql.join(
        part.map((row) => sql`when ${sql.lit(row.uid)} then ${sql.lit(row.tid)}`),
        sql` `,
      )
      await tx
        .updateTable('users')
        .set({ avatar_texture_id: sql<number>`case id ${cases} end` })
        .where(
          'id',
          'in',
          part.map((row) => row.uid),
        )
        .execute()
    }
  }
}
