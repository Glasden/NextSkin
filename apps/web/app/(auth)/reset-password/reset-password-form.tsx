'use client'

import { Alert, Button, Field, Form, Input, Link } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useState, type ReactNode } from 'react'
import { authErrorCode, postJson } from '../../../lib/api-client'
import { PasswordStrengthMeter } from '../password-strength-meter'

export interface ResetPasswordFormProps {
  token: string
  password: { min: number; max: number }
  /** 重设成功后去登录的链接 */
  signIn: ReactNode
}

export function ResetPasswordForm({ token, password, signIn }: ResetPasswordFormProps) {
  const t = useTranslations()
  const [pending, setPending] = useState(false)
  const [state, setState] = useState<'form' | 'done' | 'invalid'>('form')
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [newPassword, setNewPassword] = useState('')

  async function submit(values: { newPassword?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson('/api/auth/reset-password', { newPassword: values.newPassword, token })
    setPending(false)
    const code = authErrorCode(data)
    if (status === 200) setState('done')
    else if (code === 'INVALID_TOKEN') setState('invalid')
    else if (code === 'PASSWORD_TOO_SHORT') setErrors({ newPassword: t('errors.password_too_short', password) })
    else if (code === 'PASSWORD_TOO_LONG') setErrors({ newPassword: t('errors.password_too_long', password) })
    else setError(t('auth.resetPassword.failed'))
  }

  if (state === 'done')
    return (
      <div className="flex flex-col gap-6">
        <Alert tone="success" title={t('auth.resetPassword.doneTitle')}>
          {t('auth.resetPassword.done')}
        </Alert>
        <p className="text-sm">{signIn}</p>
      </div>
    )
  if (state === 'invalid')
    return (
      <div className="flex flex-col gap-6">
        <Alert tone="danger">{t('auth.resetPassword.invalidLink')}</Alert>
        <p className="text-sm">
          <Link render={<NextLink href="/forgot-password" />}>{t('auth.resetPassword.requestAgain')}</Link>
        </p>
      </div>
    )

  return (
    <Form errors={errors} onFormSubmit={(values) => void submit(values)}>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field
        label={t('auth.resetPassword.newPassword')}
        name="newPassword"
        description={t('auth.signUp.passwordHint', password)}
      >
        <Input
          type="password"
          autoComplete="new-password"
          required
          minLength={password.min}
          maxLength={password.max}
          value={newPassword}
          onValueChange={setNewPassword}
        />
        <PasswordStrengthMeter password={newPassword} />
      </Field>
      <div className="mt-2">
        <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
          {t('auth.resetPassword.submit')}
        </Button>
      </div>
    </Form>
  )
}
