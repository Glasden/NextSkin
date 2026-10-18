import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@nextskin/domain'
import { Alert, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { pluginTranslator } from '../../../lib/plugins'
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
  const [{ core }, t, locale] = await Promise.all([getServer(), getTranslations('auth.signUp'), getLocale()])
  const [settings, mailConfigured, initialized] = await Promise.all([
    core.settings.read([
      'auth.registration.enabled',
      'auth.registration.withPlayerName',
      'player.nameRule',
      'player.nameLength',
    ]),
    core.mail.configured(),
    core.setup.isInitialized(),
  ])
  const heading = (
    <AuthHeading title={t('title')}>
      {t('hasAccount')} <Link render={<NextLink href="/sign-in" />}>{t('signIn')}</Link>
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
  // 插件加在注册表单上的字段（ADR-0033），文案在服务端翻译好
  const pluginFields = core.plugins.registerFields().map(({ pluginId, field }) => {
    const translate = pluginTranslator(core, pluginId, locale)
    return {
      pluginId,
      field: {
        name: field.name,
        type: field.type,
        label: translate(field.label),
        help: field.help ? translate(field.help) : undefined,
        placeholder: field.placeholder ? translate(field.placeholder) : undefined,
        required: field.required,
        maxLength: field.maxLength,
        options: field.options?.map((option) => ({ value: option.value, label: translate(option.label) })),
      },
    }
  })
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
      />
    </>
  )
}
