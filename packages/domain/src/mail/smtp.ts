import nodemailer from 'nodemailer'
import { DomainError } from '../errors.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import type { MailTransport } from './types.ts'

export function createSmtpTransport(settings: ReturnType<typeof createSettingQueries>): MailTransport {
  return {
    async send(message) {
      const values = await settings.read(['mail.transport', 'mail.smtp', 'mail.smtp.password'])
      if (values['mail.transport'] !== 'smtp') throw new DomainError('mail_not_configured')
      const smtp = values['mail.smtp']
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.security === 'tls',
        requireTLS: smtp.security === 'starttls',
        ignoreTLS: smtp.security === 'none',
        ...(smtp.username ? { auth: { user: smtp.username, pass: values['mail.smtp.password'] } } : {}),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        dnsTimeout: 10_000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      })
      // 连接和空闲超时由 SMTP 实现处理，整个尝试的时间上限由任务执行器处理。
      try {
        const result = await transport.sendMail(message)
        return { messageId: result.messageId ?? null }
      } finally {
        transport.close()
      }
    },
  }
}
