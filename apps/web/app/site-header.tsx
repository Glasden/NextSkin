import { can, hasAdminAccess } from '@nextskin/domain'
import { cx, Link, Logo, Notice } from '@nextskin/ui'
import { getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { ToolCase } from 'pixelarticons/react/ToolCase.js'
import { getServer } from '../lib/server'
import { getSessionUser } from '../lib/session'
import { siteImageUrl } from '../lib/site-images'
import { ColorModeMenu } from './color-mode-menu'
import { NotificationBell } from './notification-bell'
import { SiteNav } from './site-nav'
import { UserMenu } from './user/user-menu'

/**
 * 全站的页头：标志、全站导航，右边是亮暗模式、通知铃铛（ADR-0052，被封禁的用户没有）和用户菜单；没有登录时是登录、注册的链接。
 * wide：后台的正文比前台宽（ADR-0027），页头跟着放宽，标志和侧栏才对得齐。
 * 手动维护期间（ADR-0044）只有管理员走得到这里，页头下方提醒他们维护还开着；超级管理员多一个去维护设置的链接
 */
export async function SiteHeader({ wide = false }: { wide?: boolean } = {}) {
  const [{ core }, user, t, locale] = await Promise.all([
    getServer(),
    getSessionUser(),
    getTranslations('site'),
    getLocale(),
  ])
  const [settings, notifications] = await Promise.all([
    core.settings.read(['site.name', 'site.logo', 'maintenance.enabled', 'maintenance.blockProtocols']),
    user && user.role !== 'banned' ? core.notifications.summary(user.uid, locale) : null,
  ])
  const { 'site.name': siteName, 'site.logo': logo } = settings
  const admin = user !== null && hasAdminAccess(user.role)
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border bg-surface">
        {/* 窄屏放不下一行：导航换到第二行，横向滚动；宽屏标志、导航、用户菜单排成一行 */}
        <div
          className={cx(
            'mx-auto flex w-full flex-wrap items-center gap-x-6 px-4 sm:flex-nowrap sm:px-6',
            wide ? 'max-w-7xl' : 'max-w-6xl',
          )}
        >
          <div className="flex h-16 items-center">
            <Logo name={siteName} image={logo ? siteImageUrl(logo) : undefined} render={<NextLink href="/" />} />
          </div>
          <div className="order-last w-full overflow-x-auto pb-2 sm:order-none sm:w-auto sm:min-w-0 sm:flex-1 sm:pb-0">
            <SiteNav />
          </div>
          <div className="ml-auto flex h-16 min-w-0 shrink-0 items-center gap-4 text-sm">
            <ColorModeMenu />
            {notifications && <NotificationBell initial={notifications} />}
            {user ? (
              <UserMenu nickname={user.nickname} admin={admin} />
            ) : (
              <>
                <Link render={<NextLink href="/sign-in" />}>{t('signIn')}</Link>
                <Link render={<NextLink href="/sign-up" />}>{t('signUp')}</Link>
              </>
            )}
          </div>
        </div>
      </header>
      {user && admin && settings['maintenance.enabled'] && (
        <Notice
          label={t('maintenance.label')}
          icon={<ToolCase />}
          wide={wide}
          action={
            can(user.role, 'settings.manage') ? (
              <Link render={<NextLink href="/admin/settings/maintenance" />}>{t('maintenance.settings')}</Link>
            ) : undefined
          }
        >
          {t('maintenance.notice', { protocols: settings['maintenance.blockProtocols'] ? 'blocked' : 'open' })}
        </Notice>
      )}
    </>
  )
}
