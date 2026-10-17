'use client'

import { Alert, Button, Checkbox, Field, Form, Input, Link } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { authErrorCode, postJson } from '../../../lib/api-client'

/** next：登录后去的站内路径，页面已经检查过（lib/session.ts 的 safeNextPath） */
export function SignInForm({ next }: { next: string }) {
  const t = useTranslations('auth')
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remember, setRemember] = useState(true)

  async function submit(values: { email?: string; password?: string }) {
    setPending(true)
    setError(null)
    const { status, data } = await postJson('/api/auth/sign-in/email', {
      email: values.email,
      password: values.password,
      rememberMe: remember,
    })
    // 两步验证的页面还没有做；现在还没有地方开启两步验证，不会出现 twoFactorRedirect
    if (status === 200) {
      router.replace(next)
      router.refresh()
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
    <Form onFormSubmit={(values) => void submit(values)}>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label={t('email')} name="email">
        <Input type="email" autoComplete="email" required />
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
  )
}
