import { randomUUID } from 'node:crypto'
import { isSiteInitialized } from '../setup/initialized.ts'
import { collectPluginFields } from '../plugins/form-fields.ts'
import type { PluginSystem } from '../plugins/system.ts'
import {
  countRows,
  insertOrIgnore,
  toIsoTimestamp,
  transactionWithRetry,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { hashPassword } from 'better-auth/crypto'
import type { Kysely, Transaction } from 'kysely'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth/password-policy.ts'
import type { AuthService } from '../auth/service.ts'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import type { MailService } from '../mail/service.ts'
import { createPlayer, retryOnPlayerUuidRace, validatePlayerName } from '../players/create.ts'
import { adjustScore } from '../score/adjust.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { validateEmail, validateNickname } from './validation.ts'

/** 第三方登录首次建号时的凭据：不设密码，同一个事务里写绑定（ADR-0034） */
export interface ExternalCredential {
  /** `plugin:<插件 id>:<Provider id>` */
  providerId: string
  subject: string
  /** 第三方确认过这个邮箱，并且用户没有改成别的邮箱 */
  emailVerified: boolean
  /**
   * 在注册事务里认领暂存的身份（删掉那一行），返回是否认领到。没认领到说明已经被用过，同一个身份不能建两个账号；
   * 注册失败时随事务回滚，暂存的身份还在，改了再提交
   */
  claim: (tx: Transaction<CoreDatabase>) => Promise<boolean>
}

export interface RegisterInput {
  email: string
  /** 和 external 二选一 */
  password?: string
  external?: ExternalCredential
  nickname?: string
  playerName?: string
  ip: string
  locale: string | null
  /** 插件加在注册表单上的字段，按插件 id 分组：`{ [插件 id]: { [字段名]: 值 } }` */
  plugins?: Readonly<Record<string, unknown>>
}

export function createRegister(
  db: Kysely<CoreDatabase>,
  settings: ReturnType<typeof createSettingQueries>,
  auth: AuthService,
  mail: MailService,
  events: Events,
  plugins: Pick<PluginSystem, 'registerFields' | 'interceptRegister'>,
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
      'site.locale',
    ])
    if (!values['auth.registration.enabled']) throw new DomainError('registration_disabled')
    const email = validateEmail(input.email, values['auth.registration.emailDomains'])
    const external = input.external
    if ((input.password === undefined) === (external === undefined)) throw new DomainError('invalid_request')
    if (input.password !== undefined) {
      if (input.password.length < MIN_PASSWORD_LENGTH)
        throw new DomainError('password_too_short', { min: MIN_PASSWORD_LENGTH })
      if (input.password.length > MAX_PASSWORD_LENGTH)
        throw new DomainError('password_too_long', { max: MAX_PASSWORD_LENGTH })
    }
    let nickname: string
    const withPlayer = values['auth.registration.withPlayerName']
    if (withPlayer) {
      if (!input.playerName?.trim()) throw new DomainError('player_name_required')
      nickname = validatePlayerName(input.playerName, values)
    } else {
      nickname = validateNickname(input.nickname ?? '')
    }
    const extra = collectPluginFields(plugins.registerFields(), input.plugins)
    const limit = values['auth.registration.perIpLimit']
    if (limit > 0 && (await countRows(db.selectFrom('users').where('registration_ip', '=', input.ip))) >= limit)
      throw new DomainError('ip_limit_reached', { limit })
    const password = input.password === undefined ? null : await hashPassword(input.password)
    const emailVerified = external?.emailVerified ?? false
    const scope = {
      requestId: randomUUID(),
      // 注册的人这时还不是用户
      actor: { kind: 'system' as const },
      locale: input.locale ?? values['site.locale'],
      ip: input.ip,
    }
    const uid = await retryOnPlayerUuidRace(db, () =>
      transactionWithRetry(db, async (tx) => {
        // 先认领：并发提交同一个身份时，后到的在这里就停下，不会走到邮箱的唯一约束
        if (external && !(await external.claim(tx))) throw new DomainError('external_login_expired')
        if (limit > 0 && (await countRows(tx.selectFrom('users').where('registration_ip', '=', input.ip))) >= limit)
          throw new DomainError('ip_limit_reached', { limit })
        const registeredAt = toIsoTimestamp(new Date())
        const now = writeAuthDate(tx, registeredAt)
        // 事务内的拦截器（ADR-0033）：插件的写入随注册一起提交或回滚；事务重跑时它也跟着再调用一次
        await plugins.interceptRegister(
          tx,
          { email, nickname, playerName: withPlayer ? nickname : null, ip: input.ip },
          extra,
          scope,
        )
        const inserted = await insertOrIgnore(
          tx,
          'users',
          {
            nickname,
            email,
            email_verified: emailVerified,
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
        const account = {
          user_id: user.id,
          access_token: null,
          refresh_token: null,
          id_token: null,
          access_token_expires_at: null,
          refresh_token_expires_at: null,
          scope: null,
          created_at: now,
          updated_at: now,
        }
        if (external) {
          // 第三方的令牌不存（ADR-0034）。同一个身份并发完成注册时由唯一索引兜底：insertOrIgnore 在 PG 上不会让事务作废
          const bound = await insertOrIgnore(
            tx,
            'accounts',
            { ...account, provider_id: external.providerId, account_id: external.subject, password: null },
            ['provider_id', 'account_id'],
          )
          if (!bound) throw new DomainError('identity_already_bound')
        } else {
          // Better Auth 1.7.10 sign-up.mjs 的 linkAccount：accountId 与 userId 相同。
          await tx
            .insertInto('accounts')
            .values({ ...account, provider_id: 'credential', account_id: String(user.id), password })
            .execute()
        }
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
        // 每个插件只收到它自己加的表单字段
        await events.emit(
          tx,
          'user.registered',
          { kind: 'user', uid: user.id, role: 'user' },
          { user: { uid: user.id, nickname, role: 'user', avatarTid: null, registeredAt }, extra: {} },
          registeredAt,
          { extra },
        )
        return user.id
      }),
    )
    try {
      if (!emailVerified && (await mail.configured())) await auth.sendVerificationEmail(email)
    } catch {
      // 提交后的签发或入队失败不影响注册；不记录可能携带邮箱、令牌的异常。
      console.warn('[mail] verification_enqueue_failed attempt=1')
    }
    return { uid }
  }
}
