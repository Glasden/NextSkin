'use client'

import { Nav, NavItem } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { usePathname } from 'next/navigation'
import { Flag } from 'pixelarticons/react/Flag.js'
import { Layout } from 'pixelarticons/react/Layout.js'
import { Shield } from 'pixelarticons/react/Shield.js'
import { Shirt } from 'pixelarticons/react/Shirt.js'
import { User } from 'pixelarticons/react/User.js'
import { Users } from 'pixelarticons/react/Users.js'

/**
 * 用户中心的导航项，由核心登记在这里。插件运行时落地后，再合并插件声明的 `area: 'user'` 导航项（ADR-0011、ADR-0022）。
 * label 是 user.nav 下的文案键
 */
export const userNavItems = [
  { href: '/user', icon: Layout, label: 'dashboard' },
  { href: '/user/players', icon: Users, label: 'players' },
  { href: '/user/closet', icon: Shirt, label: 'closet' },
  { href: '/user/reports', icon: Flag, label: 'reports' },
  { href: '/user/profile', icon: User, label: 'profile' },
  { href: '/user/security', icon: Shield, label: 'security' },
] as const

export function UserNav() {
  const t = useTranslations('user.nav')
  const pathname = usePathname()
  return (
    <Nav label={t('label')}>
      {userNavItems.map(({ href, icon: Icon, label }) => (
        <NavItem key={href} render={<NextLink href={href} />} icon={<Icon />} current={pathname === href}>
          {t(label)}
        </NavItem>
      ))}
    </Nav>
  )
}
