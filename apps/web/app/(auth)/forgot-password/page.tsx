import { Alert, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../lib/server'
import { AuthHeading } from '../auth-heading'
import { ForgotPasswordForm } from './forgot-password-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.forgotPassword')
  return { title: t('title') }
}

export default async function ForgotPasswordPage() {
  const [{ core }, t] = await Promise.all([getServer(), getTranslations('auth')])
  const back = <Link render={<NextLink href="/sign-in" />}>{t('backToSignIn')}</Link>
  // 没有配置邮件时不显示表单，说明原因（与 BS 相同，ADR-0018）
  const [mailConfigured, captcha] = await Promise.all([core.mail.configured(), core.captcha.publicConfig()])
  if (!mailConfigured)
    return (
      <>
        <AuthHeading title={t('forgotPassword.title')} />
        <div className="flex flex-col gap-6">
          <Alert tone="warning">{t('forgotPassword.mailNotConfigured')}</Alert>
          <p className="text-sm">{back}</p>
        </div>
      </>
    )
  return (
    <>
      <AuthHeading title={t('forgotPassword.title')}>{t('forgotPassword.description')}</AuthHeading>
      <ForgotPasswordForm back={back} captcha={captcha} />
    </>
  )
}
