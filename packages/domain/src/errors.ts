/** 领域错误携带机器码、参数和可选的字段名，文案由调用方翻译（ADR-0019）。 */
export class DomainError extends Error {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly fields?: readonly string[]
  constructor(code: string, params?: Readonly<Record<string, string | number>>, fields?: readonly string[]) {
    super(code)
    this.name = 'DomainError'
    this.code = code
    this.params = params
    this.fields = fields
  }
}
