import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@nextskin/domain'
import { Alert, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { AuthHeading } from '../auth-heading'
import { ResetPasswordForm } from './reset-password-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.resetPassword')
  return { title: t('title') }
}

/** 邮件里的链接先到 Better Auth 校验令牌，有效时带着 ?token= 跳到这里，失效时带 ?error=INVALID_TOKEN */
export default async function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  const [{ token, error }, t] = await Promise.all([searchParams, getTranslations('auth')])
  const validToken = typeof token === 'string' && token && !error ? token : null
  return (
    <>
      <AuthHeading title={t('resetPassword.title')} />
      {validToken ? (
        <ResetPasswordForm
          token={validToken}
          password={{ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH }}
          signIn={<Link render={<NextLink href="/sign-in" />}>{t('backToSignIn')}</Link>}
        />
      ) : (
        <InvalidLink />
      )}
    </>
  )
}

async function InvalidLink() {
  const t = await getTranslations('auth.resetPassword')
  return (
    <div className="flex flex-col gap-6">
      <Alert tone="danger">{t('invalidLink')}</Alert>
      <p className="text-sm">
        <Link render={<NextLink href="/forgot-password" />}>{t('requestAgain')}</Link>
      </p>
    </div>
  )
}
