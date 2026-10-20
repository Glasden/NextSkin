import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@nextskin/domain'
import { Alert, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { externalProviders } from '../../../lib/external-login'
import { registerFormFields } from '../../../lib/plugins'
import { getServer } from '../../../lib/server'
import { getSessionUser, safeNextPath } from '../../../lib/session'
import { AuthHeading } from '../auth-heading'
import { AuthLink } from '../auth-link'
import { ExternalLoginButtons } from '../external-login-buttons'
import { SignUpForm } from './sign-up-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signUp')
  return { title: t('title') }
}

/** next：注册后去的站内路径，例如从 /device 过来的启动器授权（ADR-0037），和登录页一样检查过才用 */
export default async function SignUpPage({ searchParams }: PageProps<'/sign-up'>) {
  const next = safeNextPath((await searchParams).next)
  if (await getSessionUser()) redirect(next)
  const [{ core }, t, locale] = await Promise.all([getServer(), getTranslations('auth.signUp'), getLocale()])
  const [settings, mailConfigured, initialized, providers] = await Promise.all([
    core.settings.read([
      'auth.registration.enabled',
      'auth.registration.withPlayerName',
      'player.nameRule',
      'player.nameLength',
    ]),
    core.mail.configured(),
    core.setup.isInitialized(),
    externalProviders(),
  ])
  const heading = (
    <AuthHeading title={t('title')}>
      {t('hasAccount')}{' '}
      <AuthLink href={`/sign-in?next=${encodeURIComponent(next)}`} next={next}>
        {t('signIn')}
      </AuthLink>
    </AuthHeading>
  )
  // 安装之前不开放注册（ADR-0031）：先注册的人会让安装向导关闭，站点就没有超级管理员了
  if (!initialized)
    return (
      <>
        {heading}
        <Alert title={t('notInstalled')}>
          {t('notInstalledHint')} <Link render={<NextLink href="/setup" />}>{t('openSetup')}</Link>
        </Alert>
      </>
    )
  if (!settings['auth.registration.enabled'])
    return (
      <>
        {heading}
        <Alert>{t('closed')}</Alert>
      </>
    )
  const pluginFields = registerFormFields(core, locale)
  return (
    <>
      {heading}
      <SignUpForm
        pluginFields={pluginFields}
        password={{ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH }}
        playerName={
          settings['auth.registration.withPlayerName']
            ? { rule: settings['player.nameRule'], ...settings['player.nameLength'] }
            : null
        }
        verificationNotice={mailConfigured}
        next={next}
      />
      {/* 第三方登录（ADR-0034）：没有绑定的账号回来以后进"完成注册"页，和这里一样要填注册信息 */}
      {providers.length > 0 && (
        <div className="mt-4 flex flex-col gap-4">
          <p className="flex items-center gap-3 text-sm text-text-muted before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
            {t('or')}
          </p>
          <ExternalLoginButtons providers={providers} next={next} verb="signUp" />
        </div>
      )}
    </>
  )
}
