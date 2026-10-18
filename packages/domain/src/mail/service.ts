import { isIsoTimestamp, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import {
  renderResetPassword,
  renderVerifyEmail,
  renderConfirmEmailChange,
  renderEmailChanged,
  renderTestEmail,
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

/** 任务里只存渲染需要的输入；链接带着令牌，进死信时去掉（ADR-0021） */
const recipient = z.object({ to: z.string(), uid: z.number() })
const mailPayload = z.discriminatedUnion('template', [
  recipient.extend({
    template: z.enum(['verifyEmail', 'resetPassword', 'confirmEmailChange']),
    url: z.string(),
    expiresAt: z.string().refine(isIsoTimestamp),
  }),
  recipient.extend({ template: z.literal('emailChanged') }),
])

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
    /** 只入队，不等发送。Better Auth 的回调也调用它，那时不在任何事务里（ADR-0021） */
    async send(kind: keyof typeof templates, user: { id: string; email: string }, url: string) {
      if (!(await configured())) throw new DomainError('mail_not_configured')
      const expiresAt = toIsoTimestamp(new Date(Date.now() + templates[kind].ttl * 1000))
      await jobs.enqueue(db, MAIL_JOB, { template: kind, to: user.email, uid: Number(user.id), url, expiresAt })
    },
    handler: {
      concurrency: 2,
      timeoutMs: 30_000,
      /** 按收件人的语言渲染（ADR-0019），没有设置时用站点默认语言 */
      async run({ payload }) {
        const mail = mailPayload.parse(payload)
        // 链接已经失效，发出去也没用
        if (mail.template !== 'emailChanged' && mail.expiresAt <= toIsoTimestamp(new Date())) return
        if (!(await configured())) throw new DomainError('mail_not_configured')
        const [user, values] = await Promise.all([
          db.selectFrom('users').select(['nickname', 'locale']).where('id', '=', mail.uid).executeTakeFirst(),
          settings.read(['site.name', 'site.locale', 'mail.from']),
        ])
        if (!user) return
        const input = {
          locale: (user.locale ? matchLocale(user.locale) : null) ?? values['site.locale'],
          siteName: values['site.name'],
          nickname: user.nickname,
        }
        const rendered =
          mail.template === 'emailChanged'
            ? renderEmailChanged(input)
            : templates[mail.template].render({
                ...input,
                url: mail.url,
                expiresInHours: templates[mail.template].ttl / 3600,
              })
        await transport.send({ to: mail.to, from: values['mail.from'], ...rendered })
      },
      deadLetterPayload(payload) {
        const parsed = mailPayload.safeParse(payload)
        return parsed.success ? { template: parsed.data.template, to: parsed.data.to, uid: parsed.data.uid } : null
      },
    } satisfies JobHandler,
  }
}

export type MailService = ReturnType<typeof createMailService>
