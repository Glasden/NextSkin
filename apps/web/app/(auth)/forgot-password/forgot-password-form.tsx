'use client'

import { Alert, Button, Field, Form, Input } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'
import { authErrorCode, sendJson } from '../../../lib/api-client'
import { CAPTCHA_HEADER, isCaptchaError, useCaptcha, type CaptchaConfig } from '../../../lib/captcha'

/** captcha：启用了验证码时找回密码要过，挡住拿站点给任意邮箱发信（ADR-0038） */
export function ForgotPasswordForm({
  back,
  captcha: captchaConfig,
}: {
  readonly back: ReactNode
  readonly captcha: CaptchaConfig | null
}) {
  const t = useTranslations('auth')
  const errors = useTranslations('errors')
  const captcha = useCaptcha(captchaConfig)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  async function submit(values: { email?: string }) {
    setError(null)
    // 隐形 reCAPTCHA 可能弹出挑战、用户也可能关掉它，所以先拿令牌，再把按钮设成提交中
    const token = await captcha.getToken()
    if (captchaConfig && !token) {
      setError(errors('captcha_required'))
      return
    }
    setPending(true)
    // 邮件里的链接先到 Better Auth 校验令牌，再带着令牌跳到 /reset-password
    const { status, data } = await sendJson(
      'POST',
      '/api/auth/request-password-reset',
      { email: values.email, redirectTo: '/reset-password' },
      { headers: token ? { [CAPTCHA_HEADER]: token } : {} },
    )
    setPending(false)
    captcha.reset()
    const code = authErrorCode(data)
    // 邮箱有没有注册过，响应都一样（ADR-0018）
    if (status === 200) setSentTo(values.email ?? '')
    else if (status === 429) setError(t('forgotPassword.tooManyAttempts'))
    else if (code === 'mail_not_configured') setError(t('forgotPassword.mailNotConfigured'))
    else if (isCaptchaError(code)) setError(errors(code))
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
      {captcha.element}
      <div className="mt-2 flex flex-col gap-6">
        <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
          {t('forgotPassword.submit')}
        </Button>
        <p className="text-sm">{back}</p>
      </div>
    </Form>
  )
}
