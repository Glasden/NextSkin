'use client'

import { Alert, Button, Checkbox, Field, Form, Input, Link } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { Key } from 'pixelarticons/react/Key.js'
import { useCallback, useState } from 'react'
import { authErrorCode, postJson } from '../../../lib/api-client'
import { ExternalLoginButtons, type ExternalProvider } from '../external-login-buttons'
import { usePasskeySignIn } from './passkey-sign-in'

/**
 * next：登录后去的站内路径，页面已经检查过（lib/session.ts 的 safeNextPath）。
 * providers：能用的第三方登录（ADR-0034），排在通行密钥后面
 */
export function SignInForm({ next, providers }: { next: string; providers: readonly ExternalProvider[] }) {
  const t = useTranslations('auth')
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remember, setRemember] = useState(true)
  const signedIn = useCallback(() => {
    router.replace(next)
    router.refresh()
  }, [router, next])
  const passkey = usePasskeySignIn(signedIn)

  async function submit(values: { email?: string; password?: string }) {
    setPending(true)
    setError(null)
    const { status, data } = await postJson('/api/auth/sign-in/email', {
      email: values.email,
      password: values.password,
      rememberMe: remember,
    })
    if (status === 200) {
      // 开着两步验证时还没有会话，Better Auth 留下挑战 Cookie，到第二步输入验证码（ADR-0023）
      if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect)
        router.push(`/sign-in/two-factor?next=${encodeURIComponent(next)}`)
      else signedIn()
      return
    }
    setError(
      status === 429
        ? t('signIn.tooManyAttempts')
        : authErrorCode(data) === 'INVALID_EMAIL_OR_PASSWORD'
          ? t('signIn.invalidCredentials')
          : t('signIn.failed'),
    )
    setPending(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <Form onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('email')} name="email">
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
