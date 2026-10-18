import { isSiteInitialized } from '../setup/initialized.ts'
import {
  countRows,
  insertOrIgnore,
  toIsoTimestamp,
  transactionWithRetry,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { hashPassword } from 'better-auth/crypto'
import type { Kysely } from 'kysely'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth/password-policy.ts'
import type { AuthService } from '../auth/service.ts'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import type { MailService } from '../mail/service.ts'
import { createPlayer, retryOnPlayerUuidRace, validatePlayerName } from '../players/create.ts'
import { adjustScore } from '../score/adjust.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { validateEmail, validateNickname } from './validation.ts'

export interface RegisterInput {
  email: string
  password: string
  nickname?: string
  playerName?: string
  ip: string
  locale: string | null
}

export function createRegister(
  db: Kysely<CoreDatabase>,
  settings: ReturnType<typeof createSettingQueries>,
  auth: AuthService,
  mail: MailService,
  events: Events,
) {
  return async function register(input: RegisterInput): Promise<{ uid: number }> {
    if (!(await isSiteInitialized(db))) throw new DomainError('setup_required')
    const values = await settings.read([
      'auth.registration.enabled',
      'auth.registration.withPlayerName',
      'auth.registration.perIpLimit',
      'auth.registration.emailDomains',
      'user.initialScore',
      'player.nameRule',
      'player.nameRegex',
      'player.nameLength',
      'player.uuidAlgorithm',
    ])
    if (!values['auth.registration.enabled']) throw new DomainError('registration_disabled')
    const email = validateEmail(input.email, values['auth.registration.emailDomains'])
    if (input.password.length < MIN_PASSWORD_LENGTH)
      throw new DomainError('password_too_short', { min: MIN_PASSWORD_LENGTH })
    if (input.password.length > MAX_PASSWORD_LENGTH)
      throw new DomainError('password_too_long', { max: MAX_PASSWORD_LENGTH })
    let nickname: string
    const withPlayer = values['auth.registration.withPlayerName']
    if (withPlayer) {
      if (!input.playerName?.trim()) throw new DomainError('player_name_required')
      nickname = validatePlayerName(input.playerName, values)
    } else {
      nickname = validateNickname(input.nickname ?? '')
    }
    const limit = values['auth.registration.perIpLimit']
    if (limit > 0 && (await countRows(db.selectFrom('users').where('registration_ip', '=', input.ip))) >= limit)
      throw new DomainError('ip_limit_reached', { limit })
    const password = await hashPassword(input.password)
    const uid = await retryOnPlayerUuidRace(db, () =>
      transactionWithRetry(db, async (tx) => {
        if (limit > 0 && (await countRows(tx.selectFrom('users').where('registration_ip', '=', input.ip))) >= limit)
          throw new DomainError('ip_limit_reached', { limit })
        const registeredAt = toIsoTimestamp(new Date())
        const now = writeAuthDate(tx, registeredAt)
        // 插件运行时落地后，在这里调用 user.register 拦截器（同一事务）。
        const inserted = await insertOrIgnore(
          tx,
          'users',
          {
            nickname,
            email,
            email_verified: false,
            role: 'user',
            registration_ip: input.ip,
            locale: input.locale,
            created_at: now,
            updated_at: now,
            image: null,
            avatar_texture_id: null,
            last_check_in_at: null,
          },
          ['email'],
        )
        if (!inserted) throw new DomainError('email_taken')
        const user = await tx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()
        // Better Auth 1.7.10 sign-up.mjs 的 linkAccount：accountId 与 userId 相同。
        await tx
          .insertInto('accounts')
          .values({
            user_id: user.id,
            provider_id: 'credential',
            account_id: String(user.id),
            password,
            access_token: null,
            refresh_token: null,
            id_token: null,
            access_token_expires_at: null,
            refresh_token_expires_at: null,
            scope: null,
            created_at: now,
            updated_at: now,
          })
          .execute()
        if (withPlayer) {
          const player = await createPlayer(tx, {
            uid: user.id,
            name: nickname,
            algorithm: values['player.uuidAlgorithm'],
            scorePaid: 0,
            now: registeredAt,
          })
          await events.emit(
            tx,
            'player.created',
            { kind: 'user', uid: user.id, role: 'user' },
            { player },
            registeredAt,
          )
        }
        // 用户以 0 分插入，初始积分记一条流水，流水之和才等于余额（ADR-0021）
        if (values['user.initialScore'] > 0)
          await adjustScore(tx, {
            uid: user.id,
            delta: values['user.initialScore'],
            reason: 'score.reasons.initial',
            now: registeredAt,
          })
        // 插件运行时落地后，extra 换成各插件自己贡献的注册表单字段
        await events.emit(
          tx,
          'user.registered',
          { kind: 'user', uid: user.id, role: 'user' },
          { user: { uid: user.id, nickname, role: 'user', avatarTid: null, registeredAt }, extra: {} },
          registeredAt,
        )
        return user.id
      }),
    )
    try {
      if (await mail.configured()) await auth.sendVerificationEmail(email)
    } catch {
      // 提交后的签发或入队失败不影响注册；不记录可能携带邮箱、令牌的异常。
      console.warn('[mail] verification_enqueue_failed attempt=1')
    }
    return { uid }
  }
}
