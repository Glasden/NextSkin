import type { MailMessage as ProviderMessage } from '@nextskin/plugin-sdk'

export interface MailMessage extends ProviderMessage {
  readonly from: { address: string; name: string }
}

export interface MailTransport {
  send(message: MailMessage): Promise<{ messageId: string | null }>
}

export type QueuedMail = Omit<MailMessage, 'from'>
