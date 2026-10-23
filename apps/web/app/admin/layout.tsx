import { can, hasAdminAccess } from '@nextskin/domain'
import { ToastProvider } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { pluginNavItems } from '../../lib/plugins'
import { getServer } from '../../lib/server'
import { getSessionUser } from '../../lib/session'
import { SiteHeader } from '../site-header'
import { AdminNav } from './admin-nav'
import { adminNavItems } from './nav-items'

/**
 * 后台的外壳：全站页头、分区导航和正文（ADR-0027）。信息密集、以桌面端为主（DESIGN.md 原则 5），正文比用户中心宽。
 * 没有登录时由各页面跳到登录页（requireAdmin 要知道原路径，布局拿不到）；没有任何后台权限的用户返回 404
 */
export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  const [user, common, t] = await Promise.all([
    getSessionUser(),
    getTranslations('common'),
    getTranslations('admin.nav'),
  ])
  if (!user) return children
  if (!hasAdminAccess(user.role)) notFound()
  const allowed = adminNavItems
    .filter(({ permission }) => permission === null || can(user.role, permission))
    .map(({ href }) => href)
  const { core } = await getServer()
  const [pending, pluginItems] = await Promise.all([
    can(user.role, 'reports.review')
      ? core.admin
          .listReports(user.uid, { status: 'pending', page: 1, perPage: 1 })
          .then(({ counts }) => counts.pending)
      : null,
    pluginNavItems('admin', user),
  ])
  const nav = <AdminNav allowed={allowed} pendingReports={pending} pluginItems={pluginItems} />
  return (
    <ToastProvider label={common('notifications')} closeLabel={common('close')}>
      <div className="flex min-h-dvh flex-col">
        {/* 窄屏没有侧栏，分区导航放进页头左边滑出的导航里 */}
        <SiteHeader wide section={{ label: t('label'), nav }} />
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 sm:px-6 lg:flex-row lg:gap-8">
          <aside className="hidden w-52 shrink-0 py-8 lg:block">{nav}</aside>
          <main className="min-w-0 flex-1 py-6 lg:py-8">{children}</main>
        </div>
      </div>
    </ToastProvider>
  )
}
