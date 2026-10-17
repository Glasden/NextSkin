import { isIsoTimestamp, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import { renderResetPassword, renderVerifyEmail } from '@nextskin/email'
import { matchLocale } from '@nextskin/i18n'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { EMAIL_VERIFICATION_TTL_SECONDS, RESET_PASSWORD_TTL_SECONDS } from '../auth/password-policy.ts'
import { DomainError } from '../errors.ts'
import type { JobHandler, JobRunner } from '../jobs/runner.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { createSmtpTransport } from './smtp.ts'
import type { MailTransport } from './types.ts'

export const MAIL_JOB = 'core:mail'

const templates = {
  verifyEmail: { render: renderVerifyEmail, ttl: EMAIL_VERIFICATION_TTL_SECONDS },
  resetPassword: { render: renderResetPassword, ttl: RESET_PASSWORD_TTL_SECONDS },
}

/** 任务里只存渲染需要的输入；链接带着令牌，进死信时去掉（ADR-0021） */
const mailPayload = z.object({
  template: z.enum(['verifyEmail', 'resetPassword']),
  to: z.string(),
  uid: z.number(),
  url: z.string(),
  expiresAt: z.string().refine(isIsoTimestamp),
})

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
  return {
    configured,
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
        if (mail.expiresAt <= toIsoTimestamp(new Date())) return
        if (!(await configured())) throw new DomainError('mail_not_configured')
        const [user, values] = await Promise.all([
          db.selectFrom('users').select(['nickname', 'locale']).where('id', '=', mail.uid).executeTakeFirst(),
          settings.read(['site.name', 'site.locale', 'mail.from']),
        ])
        if (!user) return
        const { render, ttl } = templates[mail.template]
        await transport.send({
          to: mail.to,
          from: values['mail.from'],
          ...render({
            locale: (user.locale ? matchLocale(user.locale) : null) ?? values['site.locale'],
            siteName: values['site.name'],
            nickname: user.nickname,
            url: mail.url,
            expiresInHours: ttl / 3600,
          }),
        })
      },
      deadLetterPayload(payload) {
        const parsed = mailPayload.safeParse(payload)
        return parsed.success ? { template: parsed.data.template, to: parsed.data.to, uid: parsed.data.uid } : null
      },
    } satisfies JobHandler,
  }
}

export type MailService = ReturnType<typeof createMailService>
