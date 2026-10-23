'use client'

import { PasswordMeter } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { passwordStrength } from '../../lib/password-strength'

/** 档位对应的文案键 */
const LEVEL_KEYS = { 0: 'weak', 1: 'fair', 2: 'strong', 3: 'veryStrong' } as const

/**
 * 密码输入框下面的强度指示。档位算一次，按档位取文案；还没输入时不显示
 * （空密码没必要说它弱，用户只是还没开始填）
 */
export function PasswordStrengthMeter({ password }: { readonly password: string }) {
  const t = useTranslations('auth.passwordStrength')
  const level = passwordStrength(password)
  if (level === null) return null
  const label = t(LEVEL_KEYS[level])
  return <PasswordMeter level={level} label={label} ariaLabel={t('label', { level: label })} />
}
