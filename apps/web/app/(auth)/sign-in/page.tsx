import { Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { getSessionUser, safeNextPath } from '../../../lib/session'
import { AuthHeading } from '../auth-heading'
import { SignInForm } from './sign-in-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signIn')
  return { title: t('title') }
}

export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const next = safeNextPath((await searchParams).next)
  if (await getSessionUser()) redirect(next)
  const t = await getTranslations('auth.signIn')
  return (
    <>
      <AuthHeading title={t('title')}>
        {t('noAccount')} <Link render={<NextLink href="/sign-up" />}>{t('signUp')}</Link>
      </AuthHeading>
      <SignInForm next={next} />
    </>
  )
}
