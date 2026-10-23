import { can, hasAdminAccess } from '@nextskin/domain'
import { cx, Link, Logo, Notice } from '@nextskin/ui'
import { getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { ToolCase } from 'pixelarticons/react/ToolCase.js'
import { getServer } from '../lib/server'
import { getSessionUser } from '../lib/session'
import { siteImageUrl } from '../lib/site-images'
import { ColorModeMenu } from './color-mode-menu'
import { NavSheet, type SectionNav } from './nav-sheet'
import { NotificationBell } from './notification-bell'
import { SiteNav } from './site-nav'
import { UserMenu } from './user/user-menu'

/**
 * 全站的页头：标志、全站导航，右边是亮暗模式、通知铃铛（ADR-0052，被封禁的用户没有）和用户菜单；没有登录时是登录、注册的链接。
 * wide：后台的正文比前台宽（ADR-0027），页头跟着放宽，标志和侧栏才对得齐。
 * section：用户中心和后台的分区导航，窄屏没有侧栏时放进左边滑出的导航里。
 * 手动维护期间（ADR-0044）只有管理员走得到这里，页头下方提醒他们维护还开着；超级管理员多一个去维护设置的链接
 */
export async function SiteHeader({ wide = false, section }: { wide?: boolean; section?: SectionNav } = {}) {
  const [{ core }, user, t, locale] = await Promise.all([
    getServer(),
    getSessionUser(),
    getTranslations('site'),
    getLocale(),
  ])
  const active = user && user.role !== 'banned'
  const [settings, notifications, themes] = await Promise.all([
    core.settings.read(['site.name', 'site.logo', 'maintenance.enabled', 'maintenance.blockProtocols']),
    active ? core.notifications.summary(user.uid, locale) : null,
    // 启用的主题不到两套时没得挑，不给主题页的入口（ADR-0057）
    active ? core.themes.selectableCount() : 0,
  ])
  const { 'site.name': siteName, 'site.logo': logo } = settings
  const logoUrl = logo ? siteImageUrl(logo) : undefined
  const admin = user !== null && hasAdminAccess(user.role)
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border bg-surface">
        {/* 始终一行。窄屏放不下导航，收进左边滑出的 Sheet：前台在 sm 以下，用户中心和后台在没有侧栏的 lg 以下；
            站点名 md 以下只留图形（DESIGN.md §10） */}
        <div
          className={cx(
            'mx-auto flex h-16 w-full items-center gap-4 px-4 sm:gap-6 sm:px-6',
            wide ? 'max-w-7xl' : 'max-w-6xl',
          )}
        >
          {/* 放不下时谁让位：md 以下左边只有按钮和图形，由右边的昵称截断；更宽时由站点名截断 */}
          <div className="flex shrink-0 items-center gap-2 md:min-w-0 md:shrink">
            <div className={section ? 'lg:hidden' : 'sm:hidden'}>
              <NavSheet siteName={siteName} logo={logoUrl} section={section} />
            </div>
            <Logo compact name={siteName} image={logoUrl} render={<NextLink href="/" />} />
          </div>
          <div className="hidden min-w-max flex-1 sm:block">
            <SiteNav />
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-4 text-sm md:shrink-0">
            <ColorModeMenu themeLink={themes > 1} />
            {notifications && <NotificationBell initial={notifications} />}
            {user ? (
              <UserMenu nickname={user.nickname} admin={admin} themes={themes > 1} />
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
