import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@nextskin/domain'
import { Alert, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { getServer } from '../../../lib/server'
import { getSessionUser } from '../../../lib/session'
import { AuthHeading } from '../auth-heading'
import { SignUpForm } from './sign-up-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signUp')
  return { title: t('title') }
}

export default async function SignUpPage() {
  if (await getSessionUser()) redirect('/user')
  const [{ core }, t] = await Promise.all([getServer(), getTranslations('auth.signUp')])
  const [settings, mailConfigured] = await Promise.all([
    core.settings.read([
      'auth.registration.enabled',
      'auth.registration.withPlayerName',
      'player.nameRule',
      'player.nameLength',
    ]),
    core.mail.configured(),
  ])
  const heading = (
    <AuthHeading title={t('title')}>
      {t('hasAccount')} <Link render={<NextLink href="/sign-in" />}>{t('signIn')}</Link>
    </AuthHeading>
  )
  if (!settings['auth.registration.enabled'])
    return (
      <>
        {heading}
        <Alert>{t('closed')}</Alert>
      </>
    )
  return (
    <>
      {heading}
      <SignUpForm
        password={{ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH }}
        playerName={
          settings['auth.registration.withPlayerName']
            ? { rule: settings['player.nameRule'], ...settings['player.nameLength'] }
            : null
        }
        verificationNotice={mailConfigured}
      />
    </>
  )
}
