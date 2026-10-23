import { ToastProvider } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { pluginNavItems } from '../../lib/plugins'
import { getServer } from '../../lib/server'
import { getSessionUser } from '../../lib/session'
import { SiteFooter } from '../site-footer'
import { SiteHeader } from '../site-header'
import { SignOutButton } from './user-menu'
import { UserNav } from './user-nav'

/**
 * 用户中心的外壳：全站页头、分区导航、正文和页脚。没有登录时由各页面跳到登录页（requireUser 要知道原路径，布局拿不到），
 * 这里只渲染正文；被封禁的用户只看到封禁说明（ADR-0022）
 */
export default async function UserLayout({ children }: { readonly children: ReactNode }) {
  const [user, t, common] = await Promise.all([getSessionUser(), getTranslations('user'), getTranslations('common')])
  if (!user) return children
  const { core } = await getServer()
  const [pluginItems, themes] = await Promise.all([pluginNavItems('user', user), core.themes.selectableCount()])
  const banned = user.role === 'banned'
  const nav = <UserNav pluginItems={pluginItems} themes={themes > 1} />
  return (
    <ToastProvider label={common('notifications')} closeLabel={common('close')}>
      <div className="flex min-h-dvh flex-col">
        {/* 窄屏没有侧栏，分区导航放进页头左边滑出的导航里 */}
        <SiteHeader section={banned ? undefined : { label: t('nav.label'), nav }} />
        {banned ? (
          <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-start gap-4 px-4 py-16">
            <h1 className="font-pixel text-pixel-2 text-text">{t('banned.title')}</h1>
            <p className="text-base text-text">{t('banned.description')}</p>
            <SignOutButton />
          </main>
        ) : (
          <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6 lg:flex-row lg:gap-10">
            <aside className="hidden w-52 shrink-0 py-8 lg:block">{nav}</aside>
            <main className="min-w-0 flex-1 py-6 lg:py-8">{children}</main>
          </div>
        )}
        <SiteFooter />
      </div>
    </ToastProvider>
  )
}
