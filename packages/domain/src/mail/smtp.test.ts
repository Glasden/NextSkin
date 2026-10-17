import nodemailer from 'nodemailer'
import { beforeEach, expect, test, vi } from 'vitest'
import type { createSettingQueries } from '../settings/queries.ts'
import { coreSettingsRegistry, type CoreSettings } from '../settings/registry.ts'
import { createSmtpTransport } from './smtp.ts'

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))
const sendMail = vi.fn()
const close = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  sendMail.mockResolvedValue({ messageId: 'smtp-id' })
  vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail, close } as unknown as ReturnType<
    typeof nodemailer.createTransport
  >)
})

test('SMTP 每次读当前设置，三种安全模式、认证和超时配置正确，禁用文件与 URL 读取', async () => {
  const values = Object.fromEntries(
    Object.entries(coreSettingsRegistry).map(([key, definition]) => [key, definition.schema.parse(definition.default)]),
  ) as CoreSettings
  const read: ReturnType<typeof createSettingQueries>['read'] = (keys) =>
    Promise.resolve(
      Object.fromEntries(keys.map((key) => [key, values[key]])) as Pick<CoreSettings, (typeof keys)[number]>,
    )
  const transport = createSmtpTransport({ read })
  const message = {
    to: 'recipient@example.test',
    from: { address: 'sender@example.test', name: 'Sender' },
    subject: 'test',
    html: '<p>test</p>',
    text: 'test',
  }
  await expect(transport.send(message)).rejects.toMatchObject({ code: 'mail_not_configured' })
  expect(nodemailer.createTransport).not.toHaveBeenCalled()
  values['mail.transport'] = 'smtp'
  values['mail.smtp.password'] = 'SECRET'
  for (const security of ['tls', 'starttls', 'none'] as const) {
    values['mail.smtp'] = { host: `${security}.example.test`, port: 587, security, username: 'smtp-user' }
    expect(await transport.send(message)).toEqual({ messageId: 'smtp-id' })
    expect(nodemailer.createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: `${security}.example.test`,
        secure: security === 'tls',
        requireTLS: security === 'starttls',
        ignoreTLS: security === 'none',
        auth: { user: 'smtp-user', pass: 'SECRET' },
        connectionTimeout: 10_000,
        socketTimeout: 20_000,
        disableFileAccess: true,
        disableUrlAccess: true,
        debug: false,
        logger: false,
      }),
    )
  }
  expect(sendMail).toHaveBeenLastCalledWith(message)
  expect(close).toHaveBeenCalledTimes(3)
  values['mail.smtp'].username = ''
  sendMail.mockRejectedValueOnce(new Error('transport failure'))
  await expect(transport.send(message)).rejects.toThrow('transport failure')
  const lastOptions: unknown = vi.mocked(nodemailer.createTransport).mock.calls.at(-1)?.[0]
  expect(lastOptions).not.toHaveProperty('auth')
  expect(close).toHaveBeenCalledTimes(4)
})
