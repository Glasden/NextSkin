import { DomainError } from '../errors.ts'

export function validateTextureName(input: string, regex: string): string {
  const name = input.trim()
  if ([...name].length < 1 || [...name].length > 128) throw new DomainError('texture_name_length', { min: 1, max: 128 })
  if (regex) {
    let rule: RegExp
    try {
      rule = new RegExp(regex, 'u')
    } catch {
      throw new DomainError('texture_name_rule_misconfigured')
    }
    if (!rule.test(name)) throw new DomainError('texture_name_invalid')
  }
  return name
}
export function validateTextureDescription(input?: string | null): string | null {
  const description = input?.trim() || null
  if (description && [...description].length > 2000)
    throw new DomainError('texture_description_too_long', { max: 2000 })
  return description
}
