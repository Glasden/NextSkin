'use client'

import { Alert, Button, Checkbox, Field, Form, Input, Link } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { Key } from 'pixelarticons/react/Key.js'
import { useCallback, useState } from 'react'
import { authErrorCode, sendJson } from '../../../lib/api-client'
import { CAPTCHA_HEADER, isCaptchaError, useCaptcha, type CaptchaConfig } from '../../../lib/captcha'
import { goToNext } from '../../../lib/navigation'
import { ExternalLoginButtons, type ExternalProvider } from '../external-login-buttons'
import { usePasskeySignIn } from './passkey-sign-in'

/**
 * next：登录后去的站内路径，页面已经检查过（lib/session.ts 的 safeNextPath）。
 * providers：能用的第三方登录（ADR-0034），排在通行密钥后面。
 * captcha：启用了验证码时只拦密码登录，通行密钥和第三方登录不要（ADR-0038）
 */
export function SignInForm({
  next,
  providers,
  captcha: captchaConfig,
}: {
  next: string
  providers: readonly ExternalProvider[]
  captcha: CaptchaConfig | null
}) {
  const t = useTranslations('auth')
  const errors = useTranslations('errors')
  const common = useTranslations('common')
  const captcha = useCaptcha(captchaConfig)
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remember, setRemember] = useState(true)
  const signedIn = useCallback(() => goToNext(router, next), [router, next])
  const passkey = usePasskeySignIn(signedIn)

  async function submit(values: { email?: string; password?: string }) {
    setError(null)
    // 隐形 reCAPTCHA 可能弹出挑战、用户也可能关掉它，所以先拿令牌，再把按钮设成提交中
    const token = await captcha.getToken()
    if (captchaConfig && !token) {
      setError(errors('captcha_required'))
      return
    }
    setPending(true)
    const { status, data } = await sendJson(
      'POST',
      '/api/auth/sign-in/email',
      { email: values.email, password: values.password, rememberMe: remember },
      { headers: token ? { [CAPTCHA_HEADER]: token } : {} },
    )
    captcha.reset()
    if (status === 200) {
      // 开着两步验证时还没有会话，Better Auth 留下挑战 Cookie，到第二步输入验证码（ADR-0023）
      if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect)
        router.push(`/sign-in/two-factor?next=${encodeURIComponent(next)}`)
      else signedIn()
      return
    }
    const code = authErrorCode(data)
    setError(
      status === 429
        ? t('signIn.tooManyAttempts')
        : code === 'INVALID_EMAIL_OR_PASSWORD'
          ? t('signIn.invalidCredentials')
          : isCaptchaError(code)
            ? errors(code)
            : t('signIn.failed'),
    )
    setPending(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <Form onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('email')} name="email" formatError={common('emailFormat')}>
          {/* webauthn：浏览器支持时，在这个输入框的自动填充建议里列出本站的通行密钥 */}
          <Input type="email" autoComplete="username webauthn" required />
        </Field>
        <Field label={t('password')} name="password">
          <Input type="password" autoComplete="current-password" required />
        </Field>
        <div className="flex items-center justify-between gap-4">
          <Checkbox checked={remember} onCheckedChange={setRemember}>
            {t('signIn.remember')}
          </Checkbox>
          <span className="text-sm">
            <Link render={<NextLink href="/forgot-password" />}>{t('signIn.forgot')}</Link>
          </span>
        </div>
        {captcha.element}
        <div className="mt-2">
          <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
            {t('signIn.submit')}
          </Button>
        </div>
      </Form>
      {(passkey.supported || providers.length > 0) && (
        <div className="flex flex-col gap-4">
          <p className="flex items-center gap-3 text-sm text-text-muted before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
            {t('signIn.or')}
          </p>
          <div className="flex flex-col gap-3">
            {passkey.supported && (
              <>
                {passkey.failure && (
                  <Alert tone="danger">
                    {passkey.failure === 'expired' ? t('signIn.passkeyExpired') : t('signIn.passkeyFailed')}
                  </Alert>
                )}
                <Button size="lg" fullWidth loading={passkey.pending} onClick={() => void passkey.start()}>
                  <Key aria-hidden />
                  {t('signIn.passkey')}
                </Button>
              </>
            )}
            {providers.length > 0 && <ExternalLoginButtons providers={providers} next={next} verb="signIn" />}
          </div>
        </div>
      )}
    </div>
  )
}
