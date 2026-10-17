/** 领域错误只携带机器码和参数，文案由调用方翻译（ADR-0019）。 */
export class DomainError extends Error {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  constructor(code: string, params?: Readonly<Record<string, string | number>>) {
    super(code)
    this.name = 'DomainError'
    this.code = code
    this.params = params
  }
}
