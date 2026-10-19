/**
 * 后台的账号操作（ADR-0036"昵称和邮箱验证状态"到"改积分"、"命令行"）。每个用例一个事务：先锁自己、检查权限，
 * 再锁对象、确认对象的身份严格低于自己（admin/context.ts），之后的读写都在锁内。
 * 设置、邮件是否配置、能用的第三方都在事务外读好：读它们用的是 db，SQLite 只有一个连接，在事务里读会死锁
 */
import {
  countRows,
  isUniqueViolation,
  toIsoTimestamp,
  transactionWithRetry,
  writeAuthDate,
  type CoreDatabase,
  type IsoTimestamp,
} from '@nextskin/db'
import type { AdminAccountChange } from '@nextskin/email'
import type { Actor } from '@nextskin/plugin-sdk'
import { hashPassword } from 'better-auth/crypto'
import type { Transaction } from 'kysely'
import type { CorePermission } from '../access/permissions.ts'
import { audit, type AuditAction } from '../audit/write.ts'
import { bindingProviderId, hasLoginMethod, parseBindingProviderId, usableBindings } from '../auth/external-login.ts'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth/password-policy.ts'
import {
  deletePasswordResetLinks,
  deleteTrustedDevices,
  deleteTwoFactorChallenges,
  revokeLogins,
} from '../auth/revoke.ts'
import { DomainError } from '../errors.ts'
import { MAIL_JOB, type MailJobPayload } from '../mail/service.ts'
import { adjustScore } from '../score/adjust.ts'
import { rejectNul } from '../text.ts'
import { createEmailChangeTokens, EMAIL_CHANGE_TTL_SECONDS } from '../users/email-change-token.ts'
import { validateEmail, validateNickname } from '../users/validation.ts'
import { authorize, changeRole, lockTarget, manageableTarget, precheck, type TargetUser } from './context.ts'
import { bindingName, notifyAccountChanged, readNoticeContext, recipientLocale } from './notify.ts'
import { userView } from './queries.ts'
import type { AdminOptions } from './service.ts'
import type {
  AdminActor,
  AdminEmailChangeResult,
  AdminSetPasswordInput,
  AdminUser,
  AdminUserUpdate,
  RevokedLogins,
} from './types.ts'

/** 积分、uid 的上限：数据库里是 32 位有符号整数 */
const MAX_INT32 = 2147483647
const NOTE_MAX_LENGTH = 200
const ASSIGNABLE_ROLES: readonly string[] = ['banned', 'user', 'admin']

/**
 * 格式、转小写同注册。不查邮箱域名的允许或禁止名单：那是防用户绕过限制，管理员是有意为之，
 * 同 setRoleAsSystem（ADR-0036"改邮箱"）
 */
function normalizeEmail(input: string): string {
  return validateEmail(input, { mode: 'deny', domains: [] })
}

/** 一个账号操作的对象，以及事件和审计的 actor：后台是锁住的管理员，命令行是 system，审计的 ip 为空 */
interface Subject {
  target: TargetUser
  actor: Actor
  ip: string | null
}
type ResolveSubject = (tx: Transaction<CoreDatabase>) => Promise<Subject>

export function createAdminUsers(options: AdminOptions) {
  const { db, settings, events, now, mail, jobs, plugins } = options
  const tokens = createEmailChangeTokens(options.secretKey)
  const timestamp = () => toIsoTimestamp(now())

  /** 后台入口：锁住自己、按数据库里的身份检查权限，再锁住对象、确认能管理他（ADR-0036"能对谁做"） */
  const managed =
    (actor: AdminActor, uid: number, ...permissions: CorePermission[]): ResolveSubject =>
    async (tx) => {
      const eventActor = await authorize(tx, actor, ...permissions)
      return { target: await manageableTarget(tx, eventActor, uid), actor: eventActor, ip: actor.ip }
    }

  /**
   * 命令行入口：uid 或邮箱，不查权限和"能对谁做"（ADR-0036"命令行"）。超级管理员账号失控时邮箱多半已经被换掉，
   * 所以要能按 uid 找到
   */
  const system =
    (target: string): ResolveSubject =>
    async (tx) => {
      const value = target.trim()
      const id =
        /^[1-9]\d*$/.test(value) && Number(value) <= MAX_INT32
          ? Number(value)
          : (await tx.selectFrom('users').select('id').where('email', '=', value.toLowerCase()).executeTakeFirst())?.id
      const user = id === undefined ? undefined : await lockTarget(tx, id)
      if (!user) throw new DomainError('user_not_found')
      return { target: user, actor: { kind: 'system' }, ip: null }
    }

  function record(
    tx: Transaction<CoreDatabase>,
    subject: Subject,
    action: AuditAction,
    details: Record<string, unknown>,
    at: IsoTimestamp,
  ) {
    return audit(tx, {
      actor: subject.actor,
      action,
      subject: { type: 'user', id: subject.target.id },
      details,
      ip: subject.ip,
      now: at,
    })
  }

  async function assertEmailAvailable(tx: Transaction<CoreDatabase>, email: string, uid: number) {
    if (await tx.selectFrom('users').select('id').where('email', '=', email).where('id', '!=', uid).executeTakeFirst())
      throw new DomainError('email_taken')
  }

  /**
   * 改密码，可选收回账号（ADR-0036"改密码和收回账号"）：设密码、删通行密钥、解绑、改邮箱、作废在途的登录在同一个事务里，
   * 攻击者没有空当再登录、再加一种登录方式。不走 Better Auth 的 setPassword、changePassword：它们只能作用于当前会话的用户
   */
  async function setPassword(
    resolve: ResolveSubject,
    input: AdminSetPasswordInput,
  ): Promise<RevokedLogins & { uid: number; nickname: string }> {
    // 长度按字符串长度算，同 Better Auth 检查注册、找回密码和用户自己改密码
    if (input.password.length < MIN_PASSWORD_LENGTH)
      throw new DomainError('password_too_short', { min: MIN_PASSWORD_LENGTH })
    if (input.password.length > MAX_PASSWORD_LENGTH)
      throw new DomainError('password_too_long', { max: MAX_PASSWORD_LENGTH })
    const newEmail = input.newEmail === undefined ? undefined : normalizeEmail(input.newEmail)
    // scrypt 很耗 CPU，在事务外算好，不占着写锁（ADR-0018）；下面重跑时也不用再算
    const [hash, notice] = await Promise.all([hashPassword(input.password), readNoticeContext(mail, settings)])
    const run = () =>
      transactionWithRetry(db, async (tx) => {
        const subject = await resolve(tx)
        const { target } = subject
        const uid = target.id
        const at = timestamp()
        const credential = await tx
          .selectFrom('accounts')
          .select('id')
          .where('user_id', '=', uid)
          .where('provider_id', '=', 'credential')
          .executeTakeFirst()
        // 经第三方登录建的账号、导入时哈希认不出的账号没有密码行，插入一行，由此也能恢复一种登录方式。
        // 用户同时在安全页设置密码（Better Auth 不锁 users 的行）会撞上唯一索引，由下面重跑
        if (credential)
          await tx
            .updateTable('accounts')
            .set({ password: hash, updated_at: writeAuthDate(tx, at) })
            .where('id', '=', credential.id)
            .execute()
        else
          await tx
            .insertInto('accounts')
            .values({
              user_id: uid,
              provider_id: 'credential',
              account_id: String(uid),
              password: hash,
              access_token: null,
              refresh_token: null,
              id_token: null,
              access_token_expires_at: null,
              refresh_token_expires_at: null,
              scope: null,
              created_at: writeAuthDate(tx, at),
              updated_at: writeAuthDate(tx, at),
            })
            .execute()
        const changes: AdminAccountChange[] = [{ kind: 'password' }]
        if (input.removeOtherMethods) {
          const passkeys = await tx.deleteFrom('passkeys').where('user_id', '=', uid).executeTakeFirst()
          const count = Number(passkeys.numDeletedRows)
          if (count > 0) {
            await record(tx, subject, 'user.deletePasskeys', { nickname: target.nickname, count }, at)
            changes.push({ kind: 'passkeys', count })
          }
          // 插件停用了的绑定也解掉：只留下这个密码
          const locale = recipientLocale(target, notice)
          const bindings = await tx
            .selectFrom('accounts')
            .select(['id', 'provider_id'])
            .where('user_id', '=', uid)
            .where('provider_id', 'like', 'plugin:%')
            .orderBy('id')
            .execute()
          for (const binding of bindings) {
            await tx.deleteFrom('accounts').where('id', '=', binding.id).execute()
            const { pluginId, providerId } = parseBindingProviderId(binding.provider_id) ?? {
              pluginId: '',
              providerId: binding.provider_id,
            }
            await record(
              tx,
              subject,
              'user.unlinkAccount',
              { nickname: target.nickname, plugin: pluginId, provider: providerId },
              at,
            )
            changes.push({ kind: 'binding', provider: bindingName(plugins, pluginId, providerId, locale) })
          }
        }
        if (newEmail !== undefined) {
          if (newEmail === target.email) throw new DomainError('email_unchanged')
          await assertEmailAvailable(tx, newEmail, uid)
          // 管理员在站外核实过，立即生效、算已验证。email_version 由下面作废在途的登录加一，还没用的找回链接也由它删掉
          await tx
            .updateTable('users')
            .set({ email: newEmail, email_verified: true, updated_at: writeAuthDate(tx, at) })
            .where('id', '=', uid)
            .execute()
          await events.emit(tx, 'user.profileUpdated', subject.actor, { uid, fields: ['email'] }, at)
          await record(
            tx,
            subject,
            'user.setEmail',
            { nickname: target.nickname, from: target.email, to: newEmail, pending: false, verified: true },
            at,
          )
          changes.push({ kind: 'email', pending: false })
        }
        const revoked = await revokeLogins(tx, uid)
        await events.emit(tx, 'user.profileUpdated', subject.actor, { uid, fields: ['password'] }, at)
        await record(tx, subject, 'user.setPassword', { nickname: target.nickname, created: !credential }, at)
        // 一封信列出这次改的全部项目；改了邮箱时发给旧地址
        await notifyAccountChanged(tx, jobs, notice, { uid, to: target.email, changes, at })
        return { ...revoked, uid, nickname: target.nickname }
      })
    try {
      return await run()
    } catch (error) {
      if (!isUniqueViolation(db, error)) throw error
    }
    // 唯一冲突在 PG 上让整个事务作废，只能在事务外把整个用例重跑一次，这次走更新密码行的路径；
    // 同角色创建的 retryOnPlayerUuidRace。新邮箱这期间被别人占了，重跑时由上面的检查报 email_taken
    try {
      return await run()
    } catch (error) {
      if (newEmail !== undefined && isUniqueViolation(db, error)) throw new DomainError('email_taken')
      throw error
    }
  }

  /**
   * 关两步验证（ADR-0036"关两步验证"）。不退出登录：已有的会话本来就过了第二步。不动通行密钥，不发事件（ADR-0023）。
   * 依赖 Better Auth 两步验证插件的表和 verifications 的标识格式，由"关掉之后能重新开启、信任过的设备要重新过第二步"的测试守住
   */
  async function disableTwoFactor(resolve: ResolveSubject): Promise<AdminUser> {
    const notice = await readNoticeContext(mail, settings)
    return transactionWithRetry(db, async (tx) => {
      const subject = await resolve(tx)
      const { target } = subject
      // 只改开关的话，用户之后再开启会被 Better Auth 以"已经开启"拒绝；网页和启动器共用的失败锁定也在这一行里
      const removed = await tx.deleteFrom('two_factors').where('user_id', '=', target.id).executeTakeFirst()
      if (target.twoFactorEnabled)
        await tx.updateTable('users').set({ two_factor_enabled: false }).where('id', '=', target.id).execute()
      // Better Auth 自己关闭时只删当前设备的信任记录。管理员关闭多半是因为设备丢了，不删的话，
      // 用户重新开启之后旧设备照样不用过第二步；还没补上第二步的挑战也一起作废。
      // 开关已经关着也照样删：用户可能已经在别的设备上自己关掉了，那台丢了的设备的记录还在
      await deleteTwoFactorChallenges(tx, target.id)
      await deleteTrustedDevices(tx, target.id)
      // 开关和密钥行本来就没有时，对用户来说什么也没变：不写审计、不通知
      if (!target.twoFactorEnabled && Number(removed.numDeletedRows) === 0) return userView(tx, target.id)
      const at = timestamp()
      await record(tx, subject, 'user.disableTwoFactor', { nickname: target.nickname }, at)
      await notifyAccountChanged(tx, jobs, notice, {
        uid: target.id,
        to: target.email,
        changes: [{ kind: 'twoFactor' }],
        at,
      })
      return userView(tx, target.id)
    })
  }

  return {
    /**
     * PATCH /api/admin/users/{uid}：身份、昵称、邮箱验证状态，至少一项。每项各按自己的权限检查，在同一个事务里执行；
     * 真正改了的项各发各的事件、各写一条审计，和当前值相同的项什么也不做（ADR-0036"昵称和邮箱验证状态"）
     */
    async updateUser(actor: AdminActor, uid: number, input: AdminUserUpdate): Promise<AdminUser> {
      const { role, emailVerified, expectedEmail } = input
      if (role === undefined && input.nickname === undefined && emailVerified === undefined)
        throw new DomainError('invalid_request')
      if (role !== undefined && !ASSIGNABLE_ROLES.includes(role)) throw new DomainError('invalid_request')
      // 设成已验证时要带上页面上显示、管理员核实过的地址；设成未验证不要求
      if (emailVerified === true && expectedEmail === undefined) throw new DomainError('invalid_request')
      const nickname = input.nickname === undefined ? undefined : validateNickname(input.nickname)
      const permissions: CorePermission[] = []
      if (role !== undefined) permissions.push('users.ban')
      if (role === 'admin') permissions.push('users.appointAdmin')
      if (nickname !== undefined || emailVerified !== undefined) permissions.push('users.manage')
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, ...permissions)
        const target = await manageableTarget(tx, eventActor, uid)
        const subject: Subject = { target, actor: eventActor, ip: actor.ip }
        const at = timestamp()
        let current = target.nickname
        if (nickname !== undefined && nickname !== target.nickname) {
          await tx
            .updateTable('users')
            .set({ nickname, updated_at: writeAuthDate(tx, at) })
            .where('id', '=', uid)
            .execute()
          await events.emit(tx, 'user.profileUpdated', eventActor, { uid, fields: ['nickname'] }, at)
          await record(tx, subject, 'user.setNickname', { from: target.nickname, to: nickname }, at)
          current = nickname
        }
        if (emailVerified !== undefined) {
          // 锁住之后再比较：另一个管理员刚改的、或者用户在没有配置邮件的站点上刚改的地址，没人核实过，不能标成已验证
          if (emailVerified && expectedEmail !== target.email) throw new DomainError('email_changed')
          // 不发事件：用户自己经 Better Auth 验证邮箱时也不发，只在这条路径上发的话插件看到的是半套
          if (emailVerified !== target.emailVerified) {
            await tx
              .updateTable('users')
              .set({ email_verified: emailVerified, updated_at: writeAuthDate(tx, at) })
              .where('id', '=', uid)
              .execute()
            await record(
              tx,
              subject,
              'user.setEmailVerified',
              { nickname: current, email: target.email, from: target.emailVerified, to: emailVerified },
              at,
            )
          }
        }
        if (role !== undefined)
          await changeRole(
            tx,
            events,
            { id: uid, nickname: current, role: target.role },
            role,
            eventActor,
            actor.ip,
            at,
          )
        return userView(tx, uid)
      })
    },

    /**
     * 改邮箱（ADR-0036"改邮箱"）。配置了邮件时同用户自己改邮箱：给新地址发确认链接，确认之后才生效、成为已验证，
     * verified 不起作用；没有配置邮件时立即生效，verified 决定新地址算不算已验证，缺省是 false
     */
    async changeUserEmail(
      actor: AdminActor,
      uid: number,
      input: { email: string; verified?: boolean },
      requestRoot: string,
    ): Promise<AdminEmailChangeResult> {
      const email = normalizeEmail(input.email)
      const [notice, values] = await Promise.all([readNoticeContext(mail, settings), settings.read(['site.url'])])
      // 确认链接里的站点地址：同用户自己改邮箱，生产环境必须在设置里填写
      const root = values['site.url'].replace(/\/+$/, '') || (options.production ? '' : requestRoot.replace(/\/+$/, ''))
      if (notice.configured && !root) throw new Error('site_url_required')
      try {
        return await transactionWithRetry(db, async (tx): Promise<AdminEmailChangeResult> => {
          const subject = await managed(actor, uid, 'users.manage')(tx)
          const { target } = subject
          if (target.email === email) throw new DomainError('email_unchanged')
          await assertEmailAvailable(tx, email, uid)
          const at = timestamp()
          if (notice.configured) {
            // 被封禁的用户点确认会被拒绝（ADR-0023），发出去也没用：不写审计、不发通知
            if (target.role === 'banned') throw new DomainError('user_banned')
            // 版本先加一、令牌按加一之后的版本签发：之前发出的改邮箱链接全部作废，包括输错地址的那一条
            await tx
              .updateTable('users')
              .set((eb) => ({ email_version: eb('email_version', '+', 1) }))
              .where('id', '=', uid)
              .execute()
            // 链接的有效期按真实时间算：确认时和 tokens.parse 都拿它和 Date.now() 比较，同用户自己改邮箱
            const expiresAt = Date.now() + EMAIL_CHANGE_TTL_SECONDS * 1000
            const token = tokens.sign({
              uid,
              emailVersion: target.emailVersion + 1,
              oldEmail: target.email,
              newEmail: email,
              expiresAt,
            })
            await jobs.enqueue(tx, MAIL_JOB, {
              template: 'confirmEmailChange',
              uid,
              to: email,
              url: `${root}/confirm-email?token=${token}`,
              expiresAt: toIsoTimestamp(new Date(expiresAt)),
            } satisfies MailJobPayload)
            // 发起时就告诉旧地址：管理员账号被人滥用时，原主人至少能知道
            await notifyAccountChanged(tx, jobs, notice, {
              uid,
              to: target.email,
              changes: [{ kind: 'email', pending: true }],
              at,
            })
            await record(
              tx,
              subject,
              'user.setEmail',
              { nickname: target.nickname, from: target.email, to: email, pending: true },
              at,
            )
            return { status: 'pending', pendingEmail: email }
          }
          const verified = input.verified ?? false
          await tx
            .updateTable('users')
            .set((eb) => ({
              email,
              email_verified: verified,
              email_version: eb('email_version', '+', 1),
              updated_at: writeAuthDate(tx, at),
            }))
            .where('id', '=', uid)
            .execute()
          // 还没用的找回密码链接发到了旧地址
          await deletePasswordResetLinks(tx, uid)
          await events.emit(tx, 'user.profileUpdated', subject.actor, { uid, fields: ['email'] }, at)
          await record(
            tx,
            subject,
            'user.setEmail',
            { nickname: target.nickname, from: target.email, to: email, pending: false, verified },
            at,
          )
          return { status: 'changed', user: await userView(tx, uid) }
        })
      } catch (error) {
        // PG 唯一冲突会使整个事务作废，回滚后才转换（ADR-0023）
        if (isUniqueViolation(db, error)) throw new DomainError('email_taken')
        throw error
      }
    },

    async setUserPassword(actor: AdminActor, uid: number, input: AdminSetPasswordInput): Promise<RevokedLogins> {
      // 算哈希之前先预检：scrypt 很贵，没有权限的人不能让服务器白算
      await precheck(db, actor, uid, 'users.manage')
      // 对象被封禁也可以：收回账号正是常见的管理工作
      const { revokedSessions, revokedTokens } = await setPassword(managed(actor, uid, 'users.manage'), input)
      return { revokedSessions, revokedTokens }
    },

    disableUserTwoFactor(actor: AdminActor, uid: number): Promise<AdminUser> {
      return disableTwoFactor(managed(actor, uid, 'users.manage'))
    },

    /**
     * 删掉全部通行密钥（ADR-0036"删通行密钥"）：攻击者加的通行密钥，改密码、退出全部登录都挡不住，用它登录还不过第二步。
     * 不能删掉最后一种能用的登录方式；拿着它登进来的会话也一起作废。通行密钥在管理员打开对话框之后已经被删光了，
     * 也照样作废：通行密钥没了，拿着它登进来的会话还在
     */
    async deleteUserPasskeys(actor: AdminActor, uid: number): Promise<RevokedLogins & { deleted: number }> {
      const [usable, notice] = await Promise.all([usableBindings(plugins), readNoticeContext(mail, settings)])
      return transactionWithRetry(db, async (tx) => {
        const subject = await managed(actor, uid, 'users.manage')(tx)
        const { target } = subject
        const count = await countRows(tx.selectFrom('passkeys').where('user_id', '=', uid))
        // 一把也没有时不改变账号能不能登录，不检查
        if (count > 0 && !(await hasLoginMethod(tx, uid, usable, { withoutPasskeys: true })))
          throw new DomainError('last_login_method')
        const removed = await tx.deleteFrom('passkeys').where('user_id', '=', uid).executeTakeFirst()
        const deleted = Number(removed.numDeletedRows)
        const revoked = await revokeLogins(tx, uid)
        const at = timestamp()
        await record(tx, subject, 'user.deletePasskeys', { nickname: target.nickname, count: deleted }, at)
        if (deleted > 0)
          await notifyAccountChanged(tx, jobs, notice, {
            uid,
            to: target.email,
            changes: [{ kind: 'passkeys', count: deleted }],
            at,
          })
        return { deleted, ...revoked }
      })
    },

    /**
     * 解绑第三方账号（ADR-0036"解绑第三方账号"）。没有能用的登录方式的账号满足 ADR-0034 首次登录的第一步，
     * 盗号的人用同一个第三方账号再登录一次就绑回来，所以解的是能用的绑定时，解完之后要还有能用的登录方式。
     * 插件停用了的绑定不算能用的登录方式，解不解都不改变账号能不能登录，总能解
     */
    async unlinkUserAccount(
      actor: AdminActor,
      uid: number,
      pluginId: string,
      providerId: string,
    ): Promise<RevokedLogins> {
      const key = bindingProviderId(pluginId, providerId)
      const [usable, notice] = await Promise.all([usableBindings(plugins), readNoticeContext(mail, settings)])
      return transactionWithRetry(db, async (tx) => {
        const subject = await managed(actor, uid, 'users.manage')(tx)
        const { target } = subject
        const row = await tx
          .selectFrom('accounts')
          .select('id')
          .where('user_id', '=', uid)
          .where('provider_id', '=', key)
          .executeTakeFirst()
        if (!row) throw new DomainError('external_account_not_found')
        if (usable.has(key) && !(await hasLoginMethod(tx, uid, usable, { excluded: (provider) => provider === key })))
          throw new DomainError('last_login_method')
        await tx.deleteFrom('accounts').where('id', '=', row.id).execute()
        // 盗号的人已有的会话不能活过解绑，否则还能重新绑定
        const revoked = await revokeLogins(tx, uid)
        const at = timestamp()
        await record(
          tx,
          subject,
          'user.unlinkAccount',
          { nickname: target.nickname, plugin: pluginId, provider: providerId },
          at,
        )
        await notifyAccountChanged(tx, jobs, notice, {
          uid,
          to: target.email,
          changes: [
            { kind: 'binding', provider: bindingName(plugins, pluginId, providerId, recipientLocale(target, notice)) },
          ],
          at,
        })
        return revoked
      })
    },

    /**
     * 退出全部登录（ADR-0036"退出全部登录"，ADR-0030 留给后台的"吊销别人的启动器登录"）。
     * 不动密码、通行密钥和绑定：账号失控时用收回账号。不发事件、不通知
     */
    async revokeUserSessions(actor: AdminActor, uid: number): Promise<RevokedLogins> {
      return transactionWithRetry(db, async (tx) => {
        const subject = await managed(actor, uid, 'users.manage')(tx)
        const revoked = await revokeLogins(tx, uid)
        await record(
          tx,
          subject,
          'user.revokeSessions',
          { nickname: subject.target.nickname, sessions: revoked.revokedSessions, tokens: revoked.revokedTokens },
          timestamp(),
        )
        return revoked
      })
    },

    /**
     * 改积分只按增量（ADR-0036"改积分"）：写绝对值会覆盖管理员打开表单之后用户的签到和花费。
     * note 只进审计：积分流水没有备注列。不发事件、不通知
     */
    async adjustUserScore(
      actor: AdminActor,
      uid: number,
      input: { delta: number; note?: string },
    ): Promise<{ score: number }> {
      const { delta } = input
      if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_INT32)
        throw new DomainError('invalid_request')
      const note = input.note === undefined ? '' : rejectNul(input.note).trim()
      if ([...note].length > NOTE_MAX_LENGTH) throw new DomainError('invalid_request')
      return transactionWithRetry(db, async (tx) => {
        const subject = await managed(actor, uid, 'users.manage')(tx)
        // 余额在锁住对象之后读，到下面的 adjustScore 之间不会有别的写入。余额为负的导入用户可以加分，加完仍为负也行
        const from = subject.target.score
        if ((delta < 0 && from + delta < 0) || (delta > 0 && from + delta > MAX_INT32))
          throw new DomainError('score_out_of_range', { balance: from })
        const at = timestamp()
        const { score } = await adjustScore(tx, { uid, delta, reason: 'score.reasons.adminAdjusted', now: at })
        await record(
          tx,
          subject,
          'user.adjustScore',
          { nickname: subject.target.nickname, delta, from, to: score, ...(note ? { note } : {}) },
          at,
        )
        return { score }
      })
    },

    /** pnpm set-password：和后台的改密码共用主体，事件和审计的 actor 是 system（ADR-0036"命令行"） */
    setPasswordAsSystem(
      target: string,
      input: AdminSetPasswordInput,
    ): Promise<RevokedLogins & { uid: number; nickname: string }> {
      return setPassword(system(target), input)
    },

    /** pnpm disable-2fa：和后台的关两步验证共用主体 */
    disableTwoFactorAsSystem(target: string): Promise<AdminUser> {
      return disableTwoFactor(system(target))
    },
  }
}
