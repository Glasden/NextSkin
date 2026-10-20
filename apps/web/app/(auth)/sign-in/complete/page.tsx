import { EXTERNAL_PENDING_COOKIE } from '@nextskin/api'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@nextskin/domain'
import { Alert, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { cookies } from 'next/headers'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { playerNameInputProps, type PlayerNameRules } from '../../../../lib/player-name'
import { registerFormFields } from '../../../../lib/plugins'
import { getServer } from '../../../../lib/server'
import { getSessionUser } from '../../../../lib/session'
import { AuthHeading } from '../../auth-heading'
import { SignUpForm } from '../../sign-up/sign-up-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.complete')
  return { title: t('title') }
}

/** 第三方给的名字能通过浏览器那一道角色名校验才预填；自定义规则只有服务端认得，不预填 */
function playerNamePrefill(name: string | null, rules: PlayerNameRules): string | null {
  if (name === null) return null
  const { pattern, minLength, maxLength } = playerNameInputProps(rules)
  const length = [...name].length
  if (pattern === undefined || length < minLength || length > maxLength) return null
  return new RegExp(`^(?:${pattern})$`, 'v').test(name) ? name : null
}

/**
 * 第三方登录的"完成注册"（ADR-0034）：第三方账号还没有绑定本站的账号时，回调把身份暂存起来、跳到这里。
 * 表单和注册页相同，只是没有密码；提交后经过注册用例，邀请码、角色名这些都照常检查。总是显示这一页，不静默建号
 */
export default async function CompleteSignUpPage() {
  if (await getSessionUser()) redirect('/user')
  const [{ core }, t, auth, locale, cookieStore] = await Promise.all([
    getServer(),
    getTranslations('auth.complete'),
    getTranslations('auth'),
    getLocale(),
    cookies(),
  ])
  const pending = await core.externalLogin.pending(cookieStore.get(EXTERNAL_PENDING_COOKIE)?.value ?? null)
  if (!pending)
    return (
      <>
        <AuthHeading title={t('title')} />
        <Alert title={t('expiredTitle')}>
          {t('expired')} <Link render={<NextLink href="/sign-in" />}>{auth('backToSignIn')}</Link>
        </Alert>
      </>
    )
  const provider = core.plugins.translate(pending.pluginId, pending.label, locale)
  const [settings, mailConfigured] = await Promise.all([
    core.settings.read([
      'auth.registration.enabled',
      'auth.registration.withPlayerName',
      'player.nameRule',
      'player.nameLength',
    ]),
    core.mail.configured(),
  ])
  if (!settings['auth.registration.enabled'])
    return (
      <>
        <AuthHeading title={t('title')} />
        <Alert>{auth('signUp.closed')}</Alert>
      </>
    )
  const playerName = settings['auth.registration.withPlayerName']
    ? { rule: settings['player.nameRule'], ...settings['player.nameLength'] }
    : null
  const displayName = pending.displayName?.trim() || null
  return (
    <>
      <AuthHeading title={t('title')}>
        {displayName ? t('description', { provider, name: displayName }) : t('descriptionNoName', { provider })}
      </AuthHeading>
      <SignUpForm
        pluginFields={registerFormFields(core, locale)}
        password={{ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH }}
        playerName={playerName}
        verificationNotice={mailConfigured}
        external={{
          provider,
          email: pending.email,
          emailVerified: pending.emailVerified,
          nickname: displayName ? [...displayName].slice(0, 255).join('') : null,
          playerName: playerName ? playerNamePrefill(displayName, playerName) : null,
          next: pending.next,
        }}
      />
      <p className="mt-6 text-sm text-pretty text-text-muted">
        {t.rich('hasAccount', {
          provider,
          link: (chunks) => (
            <Link render={<NextLink href={`/sign-in?next=${encodeURIComponent(pending.next)}`} />}>{chunks}</Link>
          ),
        })}
      </p>
    </>
  )
}
