import { isUniqueViolation, toIsoTimestamp, transactionWithRetry, writeAuthDate, type CoreDatabase } from '@nextskin/db'
import { isLocale } from '@nextskin/i18n'
import type { PrivateUser } from '../dto.ts'
import type { Kysely } from 'kysely'
import { checkUserPassword, type PluginPasswordVerifier } from '../auth/password.ts'
import { deletePasswordResetLinks } from '../auth/revoke.ts'
import type { CoreOptions } from '../core.ts'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import type { JobRunner } from '../jobs/runner.ts'
import { MAIL_JOB, type MailService } from '../mail/service.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { lockTexture } from '../textures/manage.ts'
import type { TextureRemoval } from '../textures/removal.ts'
import { deleteAccountData } from './deletion.ts'
import { createEmailChangeTokens, EMAIL_CHANGE_TTL_SECONDS } from './email-change-token.ts'
import { lockUser, type UserActor } from './lock.ts'
import { createUserQueries } from './queries.ts'
import { validateEmail, validateNickname } from './validation.ts'

export type ChangeEmailResult = { status: 'pending'; pendingEmail: string } | { status: 'changed'; user: PrivateUser }

export function createUserManagement(
  options: Pick<CoreOptions, 'db' | 'secretKey' | 'production'>,
  settings: ReturnType<typeof createSettingQueries>,
  mail: MailService,
  jobs: Pick<JobRunner, 'enqueue'>,
  events: Events,
  textureRemoval: TextureRemoval,
  textureNow: () => Date,
  passwordPlugins: PluginPasswordVerifier,
) {
  const { db } = options
  const tokens = createEmailChangeTokens(options.secretKey)
  const profile = (connection: Kysely<CoreDatabase>, uid: number) =>
    createUserQueries(connection, settings).profile(uid)
  async function assertActiveUser(uid: number) {
    const user = await db.selectFrom('users').select('role').where('id', '=', uid).executeTakeFirst()
    if (!user) throw new DomainError('unauthenticated')
    if (user.role === 'banned') throw new DomainError('user_banned')
  }
  /** 在事务外核对（scrypt 不能占着写锁），返回核对通过的哈希，锁住用户之后交给 assertPasswordUnchanged */
  async function checkPassword(uid: number, password: string): Promise<string> {
    const verified = await checkUserPassword(db, uid, password, {
      legacySalt: async () => (await settings.read(['auth.legacyPasswordSalt']))['auth.legacyPasswordSalt'],
      plugins: passwordPlugins,
    })
    if (verified === null) throw new DomainError('password_incorrect')
    return verified
  }
  /**
   * 锁住用户之后确认密码还是核对时那个。后台收回账号恰好在核对之后提交的话，盗号的人拿旧密码发起的改邮箱
   * 会按加一之后的版本签发确认链接、删除账号会删掉刚收回的账号（ADR-0036"并发"）
   */
  async function assertPasswordUnchanged(tx: Kysely<CoreDatabase>, uid: number, verified: string) {
    const account = await tx
      .selectFrom('accounts')
      .select('password')
      .where('user_id', '=', uid)
      .where('provider_id', '=', 'credential')
      .executeTakeFirst()
    if (account?.password !== verified) throw new DomainError('password_incorrect')
  }
  async function previewEmailChange(token: string): Promise<{ email: string } | null> {
    const payload = tokens.parse(token)
    if (!payload) return null
    const user = await db
      .selectFrom('users')
      .select(['email', 'email_version'])
      .where('id', '=', payload.uid)
      .executeTakeFirst()
    return user?.email === payload.oldEmail && user.email_version === payload.emailVersion
      ? { email: payload.newEmail }
      : null
  }
  return {
    async updateProfile(
      actor: UserActor,
      input: { nickname?: string; locale?: string; avatar?: number | null },
    ): Promise<PrivateUser> {
      await assertActiveUser(actor.uid)
      const nickname = input.nickname === undefined ? undefined : validateNickname(input.nickname)
      if (input.locale !== undefined && !isLocale(input.locale)) throw new DomainError('locale_invalid')
      return transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        if (user.role === 'banned') throw new DomainError('user_banned')
        const before = (await profile(tx, actor.uid))!
        if (typeof input.avatar === 'number') {
          const texture = await lockTexture(tx, input.avatar)
          if (!texture || (texture.is_public === 0 && texture.uploader_id !== actor.uid))
            throw new DomainError('texture_not_found')
          if (texture.type === 'cape') throw new DomainError('texture_type_mismatch', { slot: 'avatar' })
        }
        const fields: ('nickname' | 'locale' | 'avatar')[] = []
        if (input.avatar !== undefined && input.avatar !== before.avatarTid) fields.push('avatar')
        if (nickname !== undefined && nickname !== before.nickname) fields.push('nickname')
        if (input.locale !== undefined && input.locale !== before.locale) fields.push('locale')
        if (!fields.length) return before
        const now = toIsoTimestamp(textureNow())
        await tx
          .updateTable('users')
          .set({
            ...(fields.includes('avatar') ? { avatar_texture_id: input.avatar } : {}),
            ...(fields.includes('nickname') ? { nickname } : {}),
            ...(fields.includes('locale') ? { locale: input.locale } : {}),
            updated_at: writeAuthDate(tx, now),
          })
          .where('id', '=', actor.uid)
          .execute()
        await events.emit(
          tx,
          'user.profileUpdated',
          { kind: 'user', uid: actor.uid, role: user.role },
          { uid: actor.uid, fields },
          now,
        )
        return (await profile(tx, actor.uid))!
      })
    },
    async changeEmail(
      actor: UserActor,
      input: { email: string; password: string },
      requestRoot: string,
    ): Promise<ChangeEmailResult> {
      await assertActiveUser(actor.uid)
      const verified = await checkPassword(actor.uid, input.password)
      const values = await settings.read(['auth.registration.emailDomains', 'site.url'])
      const email = validateEmail(input.email, values['auth.registration.emailDomains'])
      const configured = await mail.configured()
      const root = values['site.url'].replace(/\/+$/, '') || (options.production ? '' : requestRoot.replace(/\/+$/, ''))
      if (configured && !root) throw new Error('site_url_required')
      try {
        return await transactionWithRetry(db, async (tx) => {
          const user = await lockUser(tx, actor.uid)
          if (user.role === 'banned') throw new DomainError('user_banned')
          await assertPasswordUnchanged(tx, actor.uid, verified)
          const before = (await profile(tx, actor.uid))!
          if (before.email === email) throw new DomainError('email_unchanged')
          if (
            await tx
              .selectFrom('users')
              .select('id')
              .where('email', '=', email)
              .where('id', '!=', actor.uid)
              .executeTakeFirst()
          )
            throw new DomainError('email_taken')
          const now = toIsoTimestamp(new Date())
          if (configured) {
            const expiresAt = Date.now() + EMAIL_CHANGE_TTL_SECONDS * 1000
            const token = tokens.sign({
              uid: actor.uid,
              emailVersion: user.email_version,
              oldEmail: before.email,
              newEmail: email,
              expiresAt,
            })
            await jobs.enqueue(tx, MAIL_JOB, {
              template: 'confirmEmailChange',
              uid: actor.uid,
              to: email,
              url: `${root}/confirm-email?token=${token}`,
              expiresAt: toIsoTimestamp(new Date(expiresAt)),
            })
            return { status: 'pending', pendingEmail: email }
          }
          await tx
            .updateTable('users')
            .set((eb) => ({
              email,
              email_verified: false,
              email_version: eb('email_version', '+', 1),
              updated_at: writeAuthDate(tx, now),
            }))
            .where('id', '=', actor.uid)
            .execute()
          // 还没用的找回密码链接发到了旧地址，随邮箱改动一起作废（ADR-0036"作废在途的登录"）
          await deletePasswordResetLinks(tx, actor.uid)
          await events.emit(
            tx,
            'user.profileUpdated',
            { kind: 'user', uid: actor.uid, role: user.role },
            { uid: actor.uid, fields: ['email'] },
            now,
          )
          return { status: 'changed', user: (await profile(tx, actor.uid))! }
        })
      } catch (error) {
        if (isUniqueViolation(db, error)) throw new DomainError('email_taken')
        throw error
      }
    },
    previewEmailChange,
    async confirmEmailChange(token: string): Promise<{ email: string }> {
      const payload = tokens.parse(token)
      if (!payload) throw new DomainError('email_change_link_invalid')
      try {
        return await transactionWithRetry(db, async (tx) => {
          // 先锁行再看封禁；用户已删时同样是失效链接。
          await tx
            .updateTable('users')
            .set((eb) => ({ role: eb.ref('role') }))
            .where('id', '=', payload.uid)
            .executeTakeFirstOrThrow()
          const user = await tx
            .selectFrom('users')
            .select(['role', 'email', 'email_version'])
            .where('id', '=', payload.uid)
            .executeTakeFirst()
          if (!user) throw new DomainError('email_change_link_invalid')
          if (user.role === 'banned') throw new DomainError('user_banned')
          const now = toIsoTimestamp(new Date())
          if (
            payload.expiresAt <= Date.now() ||
            user.email !== payload.oldEmail ||
            user.email_version !== payload.emailVersion
          )
            throw new DomainError('email_change_link_invalid')
          const changed = await tx
            .updateTable('users')
            .set((eb) => ({
              email: payload.newEmail,
              email_verified: true,
              email_version: eb('email_version', '+', 1),
              updated_at: writeAuthDate(tx, now),
            }))
            .where('id', '=', payload.uid)
            .where('email', '=', payload.oldEmail)
            .where('email_version', '=', payload.emailVersion)
            .executeTakeFirstOrThrow()
          if (changed.numUpdatedRows === 0n) throw new DomainError('email_change_link_invalid')
          // 同没有配置邮件时的立即生效：发到旧地址的找回密码链接一起作废
          await deletePasswordResetLinks(tx, payload.uid)
          await events.emit(
            tx,
            'user.profileUpdated',
            { kind: 'user', uid: payload.uid, role: user.role },
            { uid: payload.uid, fields: ['email'] },
            now,
          )
          await jobs.enqueue(tx, MAIL_JOB, { template: 'emailChanged', uid: payload.uid, to: payload.oldEmail })
          return { email: payload.newEmail }
        })
      } catch (error) {
        // PG 唯一冲突会使整个事务作废，回滚后才转换。
        if (isUniqueViolation(db, error)) throw new DomainError('email_taken')
        throw error
      }
    },
    async deleteAccount(actor: UserActor, input: { password: string }): Promise<void> {
      await assertActiveUser(actor.uid)
      const verified = await checkPassword(actor.uid, input.password)
      const { 'score.refundOnDelete': refund } = await settings.read(['score.refundOnDelete'])
      await transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        if (user.role === 'admin' || user.role === 'superadmin') throw new DomainError('admin_cannot_delete_self')
        if (user.role === 'banned') throw new DomainError('user_banned')
        await assertPasswordUnchanged(tx, actor.uid, verified)
        await deleteAccountData(
          tx,
          { events, removal: textureRemoval },
          {
            uid: actor.uid,
            actor: { kind: 'user', uid: actor.uid, role: user.role },
            refund,
            now: toIsoTimestamp(textureNow()),
          },
        )
      })
    },
  }
}
