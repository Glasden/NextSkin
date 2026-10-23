import { matchLocale } from '@nextskin/i18n'
import { Badge, Link, Panel, PlayerHead } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { getServer } from '../../../lib/server'
import { requireUser } from '../../../lib/session'
import { headSrc } from '../../../lib/textures'
import { ClearAvatarButton } from './clear-avatar-button'
import { DeleteAccountDialog } from './delete-account-dialog'
import { EmailForm } from './email-form'
import { ProfileForm } from './profile-form'
import { ResendVerificationButton } from '../resend-verification-button'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('user.profile')
  return { title: t('title') }
}

/** 个人资料：头像、昵称、界面语言、邮箱、删除账号（ADR-0023、ADR-0026） */
export default async function ProfilePage() {
  const user = await requireUser('/user/profile')
  const { core } = await getServer()
  const [profile, avatar, impact, mailConfigured, hasPassword, locale, t, format] = await Promise.all([
    core.users.profile(user.uid),
    core.users.avatar(user.uid),
    core.users.deletionImpact(user.uid),
    core.mail.configured(),
    core.externalLogin.hasPassword(user.uid),
    getLocale(),
    getTranslations('user.profile'),
    getFormatter(),
  ])
  // 会话还在、用户已经被删掉的极少数情况
  if (!profile) redirect('/sign-in')
  const admin = profile.role === 'admin' || profile.role === 'superadmin'

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

      <section aria-labelledby="summary-heading" className="flex flex-col gap-3">
        <h2 id="summary-heading" className="font-pixel text-pixel-1 text-text">
          {t('summary.title')}
        </h2>
        <Panel gap={6}>
          <div className="flex min-w-0 items-center gap-4">
            <PlayerHead src={avatar ? headSrc(avatar.hash) : undefined} size={48} alt={t('summary.avatarAlt')} />
            <div className="flex min-w-0 items-center gap-3">
              <p className="truncate text-xl font-medium text-text">{profile.nickname}</p>
              {admin && <Badge>{t(`summary.roles.${profile.role === 'superadmin' ? 'superadmin' : 'admin'}`)}</Badge>}
            </div>
          </div>
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <Fact label={t('summary.email')}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate" title={profile.email}>
                  {profile.email}
                </span>
                {profile.emailVerified ? (
                  <Badge tone="success">{t('summary.verified')}</Badge>
                ) : (
                  <Badge tone="warning">{t('summary.unverified')}</Badge>
                )}
              </span>
            </Fact>
            <Fact label={t('summary.uid')}>
              <span className="font-mono tabular-nums">{profile.uid}</span>
            </Fact>
            <Fact label={t('summary.registeredAt')}>
              <time dateTime={profile.registeredAt}>
                {format.dateTime(new Date(profile.registeredAt), { dateStyle: 'medium' })}
              </time>
            </Fact>
            <Fact label={t('summary.score')}>
              <span className="tabular-nums">{format.number(profile.score)}</span>
            </Fact>
            <Fact label={t('summary.avatar')}>
              <span className="flex flex-col items-start gap-2">
                <span className="text-sm text-pretty text-text-muted">
                  {avatar ? t('summary.avatarHint') : t('summary.noAvatar')}
                </span>
                <span className="flex flex-wrap items-center gap-4 text-sm">
                  {avatar && <ClearAvatarButton />}
                  <Link render={<NextLink href="/user/closet" />}>{t('summary.closet')}</Link>
                </span>
              </span>
            </Fact>
          </dl>
        </Panel>
      </section>

      <Section id="basics" title={t('basics.title')} description={t('basics.description')}>
        <ProfileForm
          nickname={profile.nickname}
          // 还没设置过语言的老用户，表单里先选中现在看到的语言
          locale={(profile.locale && matchLocale(profile.locale)) || matchLocale(locale) || 'zh-CN'}
        />
      </Section>

      <Section
        id="email"
        title={t('email.title')}
        description={mailConfigured ? t('email.description') : t('email.descriptionNoMail')}
      >
        {!profile.emailVerified && mailConfigured && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-text">{t('email.unverified', { email: profile.email })}</p>
            <ResendVerificationButton email={profile.email} />
          </div>
        )}
        {hasPassword ? (
          <EmailForm mailConfigured={mailConfigured} />
        ) : (
          <PasswordRequired>{t('email.passwordRequired')}</PasswordRequired>
        )}
      </Section>

      <Section id="delete" title={t('delete.title')} description={t('delete.description')}>
        {admin ? (
          <p className="text-sm text-pretty text-text">{t('delete.adminBlocked')}</p>
        ) : hasPassword ? (
          <div>
            <DeleteAccountDialog players={impact.players} oauthClients={impact.oauthClients} score={profile.score} />
          </div>
        ) : (
          <PasswordRequired>{t('delete.passwordRequired')}</PasswordRequired>
        )}
      </Section>
    </div>
  )
}

/**
 * 经第三方登录注册、还没有密码的账号（ADR-0034）：改邮箱、删除账号都要核对密码，先去安全页设置密码，
 * 不另做一套不用密码的确认流程
 */
async function PasswordRequired({ children }: { children: string }) {
  const t = await getTranslations('user.profile')
  return (
    <div className="flex flex-col items-start gap-2 rounded-sm border border-dashed border-border-strong px-4 py-4">
      <p className="text-sm text-pretty text-text-muted">{children}</p>
      <span className="text-sm">
        <Link render={<NextLink href="/user/security#password" />}>{t('setPassword')}</Link>
      </span>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="min-w-0 text-base text-text">{children}</dd>
    </div>
  )
}

/** 一块设置：标题在卡片外面，与仪表盘的区块相同 */
function Section({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <h2 id={`${id}-heading`} className="font-pixel text-pixel-1 text-text">
        {title}
      </h2>
      <Panel gap={4}>
        <p className="max-w-prose text-sm text-pretty text-text-muted">{description}</p>
        {children}
      </Panel>
    </section>
  )
}
