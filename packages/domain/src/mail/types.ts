export interface MailMessage {
  readonly to: string
  readonly subject: string
  readonly html: string
  readonly text: string
  readonly replyTo?: string
  readonly from: { address: string; name: string }
}

export interface MailTransport {
  send(message: MailMessage): Promise<{ messageId: string | null }>
}
