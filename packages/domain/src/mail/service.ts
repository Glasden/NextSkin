import type { CoreDatabase } from '@nextskin/db'
import { renderResetPassword, renderVerifyEmail } from '@nextskin/email'
import { matchLocale } from '@nextskin/i18n'
import type { Kysely } from 'kysely'
import { EMAIL_VERIFICATION_TTL_SECONDS, RESET_PASSWORD_TTL_SECONDS } from '../auth/password-policy.ts'
import { DomainError } from '../errors.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { createMailQueue } from './queue.ts'
import { createSmtpTransport } from './smtp.ts'
import type { MailTransport } from './types.ts'

const templates = {
  verifyEmail: { render: renderVerifyEmail, ttl: EMAIL_VERIFICATION_TTL_SECONDS },
  resetPassword: { render: renderResetPassword, ttl: RESET_PASSWORD_TTL_SECONDS },
}

export function createMailService(
  db: Kysely<CoreDatabase>,
  settings: ReturnType<typeof createSettingQueries>,
  transport?: MailTransport,
) {
  async function configured() {
    const values = await settings.read(['mail.transport', 'mail.from'])
    return values['mail.transport'] !== 'none' && values['mail.from'].address !== ''
  }
  const queue = createMailQueue({
    transport: transport ?? createSmtpTransport(settings),
    from: async () => {
      if (!(await configured())) throw new DomainError('mail_not_configured')
      return (await settings.read(['mail.from']))['mail.from']
    },
  })
  return {
    configured,
    queue,
    /** 按收件人的语言渲染（ADR-0019），没有设置时用站点默认语言；只入队，不等发送 */
    async send(kind: 'verifyEmail' | 'resetPassword', user: { id: string; email: string; name: string }, url: string) {
      if (!(await configured())) throw new DomainError('mail_not_configured')
      const [row, values] = await Promise.all([
        db.selectFrom('users').select('locale').where('id', '=', Number(user.id)).executeTakeFirst(),
        settings.read(['site.name', 'site.locale']),
      ])
      const { render, ttl } = templates[kind]
      queue.enqueue({
        to: user.email,
        ...render({
          locale: (row?.locale ? matchLocale(row.locale) : null) ?? values['site.locale'],
          siteName: values['site.name'],
          nickname: user.name,
          url,
          expiresInHours: ttl / 3600,
        }),
      })
    },
  }
}

export type MailService = ReturnType<typeof createMailService>
