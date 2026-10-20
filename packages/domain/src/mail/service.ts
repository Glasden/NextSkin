import { isIsoTimestamp, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import {
  renderResetPassword,
  renderVerifyEmail,
  renderConfirmEmailChange,
  renderEmailChanged,
  renderExternalAccountLinked,
  renderAdminAccountChanged,
  renderTestEmail,
  type AdminAccountChange,
} from '@nextskin/email'
import { matchLocale } from '@nextskin/i18n'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { EMAIL_VERIFICATION_TTL_SECONDS, RESET_PASSWORD_TTL_SECONDS } from '../auth/password-policy.ts'
import { EMAIL_CHANGE_TTL_SECONDS } from '../users/email-change-token.ts'
import { DomainError } from '../errors.ts'
import type { JobHandler, JobRunner } from '../jobs/runner.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { createSmtpTransport } from './smtp.ts'
import type { MailTransport } from './types.ts'

export const MAIL_JOB = 'core:mail'

const templates = {
  verifyEmail: { render: renderVerifyEmail, ttl: EMAIL_VERIFICATION_TTL_SECONDS },
  resetPassword: { render: renderResetPassword, ttl: RESET_PASSWORD_TTL_SECONDS },
  confirmEmailChange: { render: renderConfirmEmailChange, ttl: EMAIL_CHANGE_TTL_SECONDS },
}

/** 管理员改了账号的哪些项（ADR-0036"通知邮件"）；binding 的 provider 是入队时按收件人的语言翻译好的名称 */
const adminAccountChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), pending: z.boolean() }),
  z.object({ kind: z.literal('password') }),
  z.object({ kind: z.literal('twoFactor') }),
  z.object({ kind: z.literal('passkeys'), count: z.number().int().positive() }),
  z.object({ kind: z.literal('binding'), provider: z.string() }),
  z.object({ kind: z.literal('playerRenamed'), from: z.string(), to: z.string() }),
  z.object({ kind: z.literal('playerDeleted'), name: z.string() }),
  z.object({ kind: z.literal('oauthClientDisabled'), name: z.string() }),
  z.object({ kind: z.literal('oauthClientDeleted'), name: z.string() }),
  z.object({ kind: z.literal('playerTransferredOut'), name: z.string() }),
  z.object({ kind: z.literal('playerTransferredIn'), name: z.string() }),
]) satisfies z.ZodType<AdminAccountChange>

/** 任务里只存渲染需要的输入；链接带着令牌，进死信时去掉（ADR-0021） */
const recipient = z.object({ to: z.string(), uid: z.number() })
const mailPayload = z.discriminatedUnion('template', [
  recipient.extend({
    template: z.enum(['verifyEmail', 'resetPassword', 'confirmEmailChange']),
    url: z.string(),
    expiresAt: z.string().refine(isIsoTimestamp),
  }),
  recipient.extend({ template: z.literal('emailChanged') }),
  /** provider 是入队时按收件人的语言翻译好的第三方名称 */
  recipient.extend({ template: z.literal('externalAccountLinked'), provider: z.string() }),
  /** at 是修改的时刻，渲染时按站点时区写出 */
  recipient.extend({
    template: z.literal('adminAccountChanged'),
    changes: z.array(adminAccountChange).min(1),
    at: z.string().refine(isIsoTimestamp),
  }),
])
/** 邮件任务的 payload：领域用例在自己的事务里直接入队时按它写（admin/notify.ts） */
export type MailJobPayload = z.input<typeof mailPayload>

export function createMailService(
  db: Kysely<CoreDatabase>,
  settings: ReturnType<typeof createSettingQueries>,
  jobs: Pick<JobRunner, 'enqueue'>,
  transport: MailTransport = createSmtpTransport(settings),
) {
  async function configured() {
    const values = await settings.read(['mail.transport', 'mail.from'])
    return values['mail.transport'] !== 'none' && values['mail.from'].address !== ''
  }
  /**
   * 测试邮件的报错要原样给超级管理员看，但 SMTP 服务器可能在报错里回显密码。
   * 把密码本身和登录时发出的 base64 形式（AUTH LOGIN 只发密码，AUTH PLAIN 发 \0用户名\0密码）都换掉（ADR-0028）
   */
  async function redactSmtpPassword(message: string) {
    const values = await settings.read(['mail.smtp', 'mail.smtp.password'])
    const password = values['mail.smtp.password']
    if (!password) return message
    const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
    return [password, base64(password), base64(`\0${values['mail.smtp'].username}\0${password}`)].reduce(
      (text, secret) => text.split(secret).join('******'),
      message,
    )
  }
  return {
    configured,
    /** 当场发送，调用方必须先完成授权事务。 */
    async sendTest(user: { email: string; nickname: string; locale: string | null }) {
      if (!(await configured())) throw new DomainError('mail_not_configured')
      const values = await settings.read(['site.name', 'site.locale', 'mail.from'])
      const rendered = renderTestEmail({
        locale: (user.locale ? matchLocale(user.locale) : null) ?? values['site.locale'],
        siteName: values['site.name'],
        nickname: user.nickname,
      })
      try {
        await transport.send({ to: user.email, from: values['mail.from'], ...rendered })
      } catch (error) {
        const message = await redactSmtpPassword(error instanceof Error ? error.message : String(error))
        throw new DomainError('mail_test_failed', { reason: [...message].slice(0, 300).join('') })
      }
    },
    /**
     * 只入队，不等发送（ADR-0021）。executor 是事务时和调用方的写入一起提交：找回密码的回调锁住用户行之后在事务里入队。
     * 传事务的调用方要先在事务外确认过 configured()：读设置用的是 db，SQLite 只有一个连接，在事务里读会死锁
     */
    async send(
      kind: keyof typeof templates,
      user: { id: string; email: string },
      url: string,
      executor: Kysely<CoreDatabase> = db,
    ) {
      if (!executor.isTransaction && !(await configured())) throw new DomainError('mail_not_configured')
      const expiresAt = toIsoTimestamp(new Date(Date.now() + templates[kind].ttl * 1000))
      await jobs.enqueue(executor, MAIL_JOB, {
        template: kind,
        to: user.email,
        uid: Number(user.id),
        url,
        expiresAt,
      } satisfies MailJobPayload)
    },
    handler: {
      concurrency: 2,
      timeoutMs: 30_000,
      /** 按收件人的语言渲染（ADR-0019），没有设置时用站点默认语言 */
      async run({ payload }) {
        const mail = mailPayload.parse(payload)
        // 链接已经失效，发出去也没用
        if ('expiresAt' in mail && mail.expiresAt <= toIsoTimestamp(new Date())) return
        if (!(await configured())) throw new DomainError('mail_not_configured')
        const [user, values] = await Promise.all([
          db.selectFrom('users').select(['nickname', 'locale']).where('id', '=', mail.uid).executeTakeFirst(),
          settings.read(['site.name', 'site.locale', 'mail.from', 'site.timeZone']),
        ])
        // 用户已经删除：删除用户不发通知（ADR-0036）
        if (!user) return
        const input = {
          locale: (user.locale ? matchLocale(user.locale) : null) ?? values['site.locale'],
          siteName: values['site.name'],
          nickname: user.nickname,
        }
        const rendered =
          mail.template === 'emailChanged'
            ? renderEmailChanged(input)
            : mail.template === 'externalAccountLinked'
              ? renderExternalAccountLinked({ ...input, provider: mail.provider })
              : mail.template === 'adminAccountChanged'
                ? renderAdminAccountChanged({
                    ...input,
                    changes: mail.changes,
                    at: mail.at,
                    timeZone: values['site.timeZone'],
                  })
                : templates[mail.template].render({
                    ...input,
                    url: mail.url,
                    expiresInHours: templates[mail.template].ttl / 3600,
                  })
        await transport.send({ to: mail.to, from: values['mail.from'], ...rendered })
      },
      deadLetterPayload(payload) {
        const parsed = mailPayload.safeParse(payload)
        if (!parsed.success) return null
        const { template, to, uid } = parsed.data
        // 改了哪些项留着供排查，里面没有链接和令牌
        if (parsed.data.template === 'adminAccountChanged') return { template, to, uid, changes: parsed.data.changes }
        return { template, to, uid }
      },
    } satisfies JobHandler,
  }
}

export type MailService = ReturnType<typeof createMailService>
