import { Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { getSessionUser } from '../../../lib/session'
import { AuthHeading } from '../auth-heading'
import { SignInForm } from './sign-in-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signIn')
  return { title: t('title') }
}

export default async function SignInPage() {
  if (await getSessionUser()) redirect('/')
  const t = await getTranslations('auth.signIn')
  return (
    <>
      <AuthHeading title={t('title')}>
        {t('noAccount')} <Link render={<NextLink href="/sign-up" />}>{t('signUp')}</Link>
      </AuthHeading>
      <SignInForm />
    </>
  )
}
