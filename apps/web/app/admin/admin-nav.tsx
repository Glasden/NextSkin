'use client'

import { Nav, NavItem } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactElement } from 'react'
import { adminNavItems, type AdminNavHref } from './nav-items'

/**
 * pendingReports：跟在“举报”后面的待处理数量，让管理员一眼看到有没有事要做。
 * pluginItems：插件声明的导航项（ADR-0033），标签已经翻译好，图标在服务端渲染
 */
export function AdminNav({
  allowed,
  pendingReports,
  pluginItems,
}: {
  allowed: readonly AdminNavHref[]
  pendingReports: number | null
  pluginItems: readonly { href: string; label: string; icon: ReactElement }[]
}) {
  const t = useTranslations('admin.nav')
  const pathname = usePathname()
  const inPlugin = pluginItems.some(({ href }) => pathname === href || pathname.startsWith(`${href}/`))
  return (
    <Nav label={t('label')}>
      {adminNavItems
        .filter(({ href }) => allowed.includes(href))
        .map(({ href, icon: Icon, label }) => (
          <NavItem
            key={href}
            render={<NextLink href={href} />}
            icon={<Icon />}
            current={
              href === '/admin'
                ? pathname === href
                : pathname.startsWith(href) && !(href === '/admin/plugins' && inPlugin)
            }
          >
            {t(label)}
            {href === '/admin/reports' && pendingReports ? (
              <span className="ml-auto pl-2 text-text-muted tabular-nums">{pendingReports}</span>
            ) : null}
          </NavItem>
        ))}
      {pluginItems.map(({ href, icon, label }) => (
        <NavItem
          key={href}
          render={<NextLink href={href} />}
          icon={icon}
          current={pathname === href || pathname.startsWith(`${href}/`)}
        >
          {label}
        </NavItem>
      ))}
    </Nav>
  )
}
