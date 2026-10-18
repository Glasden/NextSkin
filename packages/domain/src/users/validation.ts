import { z } from 'zod'
import { DomainError } from '../errors.ts'
import type { CoreSettingValue } from '../settings/registry.ts'

export function validateEmail(input: string, domains: CoreSettingValue<'auth.registration.emailDomains'>): string {
  const email = input.trim().toLowerCase()
  if (!z.email().safeParse(email).success || email.length > 255) throw new DomainError('email_invalid')
  const listed = domains.domains.includes(email.slice(email.lastIndexOf('@') + 1))
  if ((domains.mode === 'allow' && !listed) || (domains.mode === 'deny' && listed))
    throw new DomainError('email_domain_not_allowed')
  return email
}

export function validateNickname(input: string): string {
  const nickname = input.trim()
  if ([...nickname].length < 1 || [...nickname].length > 255)
    throw new DomainError('nickname_invalid', { min: 1, max: 255 })
  return nickname
}
