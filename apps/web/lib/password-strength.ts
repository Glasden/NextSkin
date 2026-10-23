/**
 * 密码强度：纯前端指示，不参与校验。密码的合法性只有长度边界（password-policy.ts），
 * 弱密码也能提交——强度只是帮用户意识到自己的密码弱。
 *
 * 以长度为主（NIST SP 800-63B）：长口令不要求大小写和符号混排，correcthorsebatterystaple
 * 这样的口令比 Pf3!xQ 强得多。字符种类只在长度不够时加分，否则一串很长的中文口令会被算成弱，
 * 而 Password123! 这种套路密码反倒算强。
 */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 | null {
  if (!password) return null
  const length = [...password].length
  if (length >= 20) return 3
  if (length >= 16) return 2
  let classes = 0
  if (/[a-z]/.test(password)) classes++
  if (/[A-Z]/.test(password)) classes++
  if (/\d/.test(password)) classes++
  if (/[^a-zA-Z\d]/.test(password)) classes++
  if (length >= 12) return classes >= 3 ? 2 : 1
  if (length >= 8) return 1
  return 0
}
