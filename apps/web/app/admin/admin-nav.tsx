'use client'

import { Nav, NavItem } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { usePathname } from 'next/navigation'
import { adminNavItems, type AdminNavHref } from './nav-items'

/** pendingReports：跟在“举报”后面的待处理数量，让管理员一眼看到有没有事要做 */
export function AdminNav({
  allowed,
  pendingReports,
}: {
  allowed: readonly AdminNavHref[]
  pendingReports: number | null
}) {
  const t = useTranslations('admin.nav')
  const pathname = usePathname()
  return (
    <Nav label={t('label')}>
      {adminNavItems
        .filter(({ href }) => allowed.includes(href))
        .map(({ href, icon: Icon, label }) => (
          <NavItem
            key={href}
            render={<NextLink href={href} />}
            icon={<Icon />}
            current={href === '/admin' ? pathname === href : pathname.startsWith(href)}
          >
            {t(label)}
            {href === '/admin/reports' && pendingReports ? (
              <span className="ml-auto pl-2 text-text-muted tabular-nums">{pendingReports}</span>
            ) : null}
          </NavItem>
        ))}
    </Nav>
  )
}
