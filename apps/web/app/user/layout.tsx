import { Logo, ToastProvider } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import type { ReactNode } from 'react'
import { getServer } from '../../lib/server'
import { getSessionUser } from '../../lib/session'
import { SignOutButton, UserMenu } from './user-menu'
import { UserNav } from './user-nav'

/**
 * 用户中心的外壳：页头、分区导航和正文。没有登录时由各页面跳到登录页（requireUser 要知道原路径，布局拿不到），
 * 这里只渲染正文；被封禁的用户只看到封禁说明（ADR-0022）
 */
export default async function UserLayout({ children }: { readonly children: ReactNode }) {
  const [{ core }, user, t, common] = await Promise.all([
    getServer(),
    getSessionUser(),
    getTranslations('user'),
    getTranslations('common'),
  ])
  if (!user) return children
  const { 'site.name': siteName } = await core.settings.read(['site.name'])
  return (
    <ToastProvider label={common('notifications')} closeLabel={common('close')}>
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-surface">
          <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
            <Logo name={siteName} render={<NextLink href="/" />} />
            <div className="min-w-0">
              <UserMenu nickname={user.nickname} />
            </div>
          </div>
        </header>
        {user.role === 'banned' ? (
          <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-start gap-4 px-4 py-16">
            <h1 className="font-pixel text-pixel-2 text-text">{t('banned.title')}</h1>
            <p className="text-base text-text">{t('banned.description')}</p>
            <SignOutButton />
          </main>
        ) : (
          <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6 lg:flex-row lg:gap-10">
            <aside className="shrink-0 border-b border-border py-3 lg:w-52 lg:border-b-0 lg:py-8">
              <UserNav />
            </aside>
            <main className="min-w-0 flex-1 py-6 lg:py-8">{children}</main>
          </div>
        )}
      </div>
    </ToastProvider>
  )
}
