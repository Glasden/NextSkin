import { Alert, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { externalErrorMessage, externalProviders } from '../../../lib/external-login'
import { getSessionUser, safeNextPath } from '../../../lib/session'
import { AuthHeading } from '../auth-heading'
import { SignInForm } from './sign-in-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signIn')
  return { title: t('title') }
}

/** 第三方登录出错时，回调带着 `?error=` 跳回这里（ADR-0034） */
export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const query = await searchParams
  const next = safeNextPath(query.next)
  if (await getSessionUser()) redirect(next)
  const [t, providers, error] = await Promise.all([
    getTranslations('auth.signIn'),
    externalProviders(),
    externalErrorMessage(query.error),
  ])
  return (
    <>
      <AuthHeading title={t('title')}>
        {t('noAccount')}{' '}
        <Link render={<NextLink href={`/sign-up?next=${encodeURIComponent(next)}`} />}>{t('signUp')}</Link>
      </AuthHeading>
      {error && (
        <div className="mb-6">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <SignInForm next={next} providers={providers} />
    </>
  )
}
