import { hasAdminAccess } from '@nextskin/domain'
import { cx, Link, Logo } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../lib/server'
import { getSessionUser } from '../lib/session'
import { SiteNav } from './site-nav'
import { UserMenu } from './user/user-menu'

/**
 * 全站的页头：标志、全站导航，右边是用户菜单；没有登录时是登录、注册的链接。
 * wide：后台的正文比前台宽（ADR-0027），页头跟着放宽，标志和侧栏才对得齐
 */
export async function SiteHeader({ wide = false }: { wide?: boolean } = {}) {
  const [{ core }, user, t] = await Promise.all([getServer(), getSessionUser(), getTranslations('site')])
  const { 'site.name': siteName } = await core.settings.read(['site.name'])
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface">
      {/* 窄屏放不下一行：导航换到第二行，横向滚动；宽屏标志、导航、用户菜单排成一行 */}
      <div
        className={cx(
          'mx-auto flex w-full flex-wrap items-center gap-x-6 px-4 sm:flex-nowrap sm:px-6',
          wide ? 'max-w-7xl' : 'max-w-6xl',
        )}
      >
        <div className="flex h-16 items-center">
          <Logo name={siteName} render={<NextLink href="/" />} />
        </div>
        <div className="order-last w-full overflow-x-auto pb-2 sm:order-none sm:w-auto sm:min-w-0 sm:flex-1 sm:pb-0">
          <SiteNav />
        </div>
        <div className="ml-auto flex h-16 min-w-0 shrink-0 items-center gap-4 text-sm">
          {user ? (
            <UserMenu nickname={user.nickname} admin={hasAdminAccess(user.role)} />
          ) : (
            <>
              <Link render={<NextLink href="/sign-in" />}>{t('signIn')}</Link>
              <Link render={<NextLink href="/sign-up" />}>{t('signUp')}</Link>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
