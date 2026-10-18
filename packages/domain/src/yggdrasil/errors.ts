export type YggdrasilErrorKind =
  'IllegalArgumentException' | 'UnauthorizedException' | 'ForbiddenOperationException' | 'NotFoundException'

/** 协议错误只带翻译键，API 层按用户或站点语言生成文案。 */
export class YggdrasilError extends Error {
  readonly kind: YggdrasilErrorKind
  readonly messageKey: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly locale: string | null

  constructor(
    kind: YggdrasilErrorKind,
    messageKey: string,
    locale: string | null = null,
    params?: Readonly<Record<string, string | number>>,
  ) {
    super(messageKey)
    this.name = 'YggdrasilError'
    this.kind = kind
    this.messageKey = messageKey
    this.locale = locale
    this.params = params
  }
}

export function forbidden(code: string, locale: string | null = null): YggdrasilError {
  return new YggdrasilError('ForbiddenOperationException', `yggdrasil.errors.${code}`, locale)
}
