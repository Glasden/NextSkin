import { can, hasAdminAccess } from '@nextskin/domain'
import { ToastProvider } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
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
  const [user, common] = await Promise.all([getSessionUser(), getTranslations('common')])
  if (!user) return children
  if (!hasAdminAccess(user.role)) notFound()
  const allowed = adminNavItems
    .filter(({ permission }) => permission === null || can(user.role, permission))
    .map(({ href }) => href)
  const { core } = await getServer()
  const pending = can(user.role, 'reports.review')
    ? (await core.admin.listReports(user.uid, { status: 'pending', page: 1, perPage: 1 })).counts.pending
    : null
  return (
    <ToastProvider label={common('notifications')} closeLabel={common('close')}>
      <div className="flex min-h-dvh flex-col">
        <SiteHeader wide />
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 sm:px-6 lg:flex-row lg:gap-8">
          <aside className="shrink-0 border-b border-border py-3 lg:w-52 lg:border-b-0 lg:py-8">
            <AdminNav allowed={allowed} pendingReports={pending} />
          </aside>
          <main className="min-w-0 flex-1 py-6 lg:py-8">{children}</main>
        </div>
      </div>
    </ToastProvider>
  )
}
