'use client'

import { Alert, Button, Field, Form, Input } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'
import { authErrorCode, postJson } from '../../../lib/api-client'

export function ForgotPasswordForm({ back }: { readonly back: ReactNode }) {
  const t = useTranslations('auth')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  async function submit(values: { email?: string }) {
    setPending(true)
    setError(null)
    // 邮件里的链接先到 Better Auth 校验令牌，再带着令牌跳到 /reset-password
    const { status, data } = await postJson('/api/auth/request-password-reset', {
      email: values.email,
      redirectTo: '/reset-password',
    })
    setPending(false)
    // 邮箱有没有注册过，响应都一样（ADR-0018）
    if (status === 200) setSentTo(values.email ?? '')
    else if (status === 429) setError(t('forgotPassword.tooManyAttempts'))
    else if (authErrorCode(data) === 'mail_not_configured') setError(t('forgotPassword.mailNotConfigured'))
    else setError(t('forgotPassword.failed'))
  }

  if (sentTo !== null)
    return (
      <div className="flex flex-col gap-6">
        <Alert tone="success" title={t('forgotPassword.sentTitle')}>
          {t('forgotPassword.sent', { email: sentTo })}
        </Alert>
        <p className="text-sm">{back}</p>
      </div>
    )

  return (
    <Form onFormSubmit={(values) => void submit(values)}>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label={t('email')} name="email">
        <Input type="email" autoComplete="email" required />
      </Field>
      <div className="mt-2 flex flex-col gap-6">
        <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
          {t('forgotPassword.submit')}
        </Button>
        <p className="text-sm">{back}</p>
      </div>
    </Form>
  )
}
