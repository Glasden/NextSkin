import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@nextskin/domain'
import { Badge } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import { Gamepad } from 'pixelarticons/react/Gamepad.js'
import { Key } from 'pixelarticons/react/Key.js'
import { Lock } from 'pixelarticons/react/Lock.js'
import { Smartphone } from 'pixelarticons/react/Smartphone.js'
import type { ReactNode } from 'react'
import { getServer } from '../../../lib/server'
import { getRequestRoot, requireUser } from '../../../lib/session'
import { ChangePasswordForm } from './change-password-form'
import { LauncherLoginsPanel } from './launcher-logins-panel'
import { PasskeysPanel } from './passkeys-panel'
import { TwoFactorPanel } from './two-factor-panel'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('user.security')
  return { title: t('title') }
}

/**
 * 登录与安全：密码、两步验证、通行密钥（ADR-0023），以及启动器登录（ADR-0030）。
 * 前三项的改动直接调用 Better Auth 的接口，启动器登录走自己的 REST 接口
 */
export default async function SecurityPage() {
  const user = await requireUser('/user/security')
  const [{ core }, root] = await Promise.all([getServer(), getRequestRoot()])
  const [security, launcherTokens, settings, t, format] = await Promise.all([
    core.auth.security(user.uid, root),
    core.yggdrasil.listTokens(user.uid),
    core.settings.read(['site.name']),
    getTranslations('user.security'),
    getFormatter(),
  ])
  const dateTime = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
  const passkeys = security.passkeys.map((passkey) => ({
    id: passkey.id,
    name: passkey.name,
    backedUp: passkey.backedUp,
    addedAt: passkey.createdAt ? dateTime(passkey.createdAt) : null,
  }))
  const launcherLogins = launcherTokens.map((token) => ({
    id: token.id,
    player: token.player?.name ?? null,
    issuedAt: dateTime(token.createdAt),
    status: token.status,
  }))

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

      <section aria-labelledby="overview-heading" className="flex flex-col gap-3">
        <h2 id="overview-heading" className="font-pixel text-pixel-1 text-text">
          {t('overview.title')}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <OverviewItem icon={<Lock aria-hidden />} label={t('password.title')}>
            <Badge tone="success">{t('overview.passwordSet')}</Badge>
          </OverviewItem>
          <OverviewItem icon={<Smartphone aria-hidden />} label={t('twoFactor.title')}>
            {security.twoFactorEnabled ? (
              <Badge tone="success">{t('overview.on')}</Badge>
            ) : (
              <Badge>{t('overview.off')}</Badge>
            )}
          </OverviewItem>
          <OverviewItem icon={<Key aria-hidden />} label={t('passkeys.title')}>
            {passkeys.length ? (
              <Badge tone="success">{t('overview.passkeyCount', { count: passkeys.length })}</Badge>
            ) : (
              <Badge>{t('overview.none')}</Badge>
            )}
          </OverviewItem>
          <OverviewItem icon={<Gamepad aria-hidden />} label={t('launchers.title')}>
            {launcherLogins.length ? (
              <Badge>{t('overview.launcherCount', { count: launcherLogins.length })}</Badge>
            ) : (
              <Badge>{t('overview.none')}</Badge>
            )}
          </OverviewItem>
        </ul>
      </section>

      <Section id="password" title={t('password.title')} description={t('password.description')}>
        <ChangePasswordForm min={MIN_PASSWORD_LENGTH} max={MAX_PASSWORD_LENGTH} />
      </Section>

      <Section
        id="two-factor"
        title={t('twoFactor.title')}
        badge={security.twoFactorEnabled ? <Badge tone="success">{t('overview.on')}</Badge> : undefined}
        description={security.twoFactorEnabled ? t('twoFactor.onDescription') : t('twoFactor.offDescription')}
      >
        <TwoFactorPanel
          enabled={security.twoFactorEnabled}
          backupCodesRemaining={security.backupCodesRemaining}
          siteName={settings['site.name']}
        />
      </Section>

      <Section
        id="passkeys"
        title={t('passkeys.title')}
        badge={passkeys.length ? <Badge>{t('overview.passkeyCount', { count: passkeys.length })}</Badge> : undefined}
        description={t('passkeys.description')}
      >
        <PasskeysPanel passkeys={passkeys} />
      </Section>

      <Section
        id="launchers"
        title={t('launchers.title')}
        badge={
          launcherLogins.length ? (
            <Badge>{t('overview.launcherCount', { count: launcherLogins.length })}</Badge>
          ) : undefined
        }
        description={t('launchers.description')}
      >
        <LauncherLoginsPanel logins={launcherLogins} />
      </Section>
    </div>
  )
}

/** 页首的保护状态，一项一格 */
function OverviewItem({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-border bg-surface p-4 text-text">
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="min-w-0 flex-1 text-base font-medium">{label}</span>
      {children}
    </li>
  )
}

/** 一块设置：标题在卡片外面，与仪表盘的区块相同 */
function Section({
  id,
  title,
  badge,
  description,
  children,
}: {
  id: string
  title: string
  badge?: ReactNode
  description: string
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id={`${id}-heading`} className="font-pixel text-pixel-1 text-text">
          {title}
        </h2>
        {badge}
      </div>
      <div className="flex flex-col gap-4 rounded-md border border-border bg-surface p-6">
        <p className="max-w-prose text-sm text-pretty text-text-muted">{description}</p>
        {children}
      </div>
    </section>
  )
}
