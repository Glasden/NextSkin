'use client'

import { Nav, NavItem } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { usePathname } from 'next/navigation'
import { Bell } from 'pixelarticons/react/Bell.js'
import { Code } from 'pixelarticons/react/Code.js'
import { ColorsSwatch } from 'pixelarticons/react/ColorsSwatch.js'
import { Flag } from 'pixelarticons/react/Flag.js'
import { Layout } from 'pixelarticons/react/Layout.js'
import { Shield } from 'pixelarticons/react/Shield.js'
import { Shirt } from 'pixelarticons/react/Shirt.js'
import { User } from 'pixelarticons/react/User.js'
import { Users } from 'pixelarticons/react/Users.js'
import type { ReactElement } from 'react'

/**
 * 用户中心的导航项，由核心登记在这里；插件声明的 `area: 'user'` 导航项由布局另外取来，排在后面（ADR-0022、ADR-0033）。
 * label 是 user.nav 下的文案键。主题页只在启用的主题有两套以上时显示（ADR-0057），用 visibleUserNavItems 取
 */
const userNavItems = [
  { href: '/user', icon: Layout, label: 'dashboard' },
  { href: '/user/notifications', icon: Bell, label: 'notifications' },
  { href: '/user/players', icon: Users, label: 'players' },
  { href: '/user/closet', icon: Shirt, label: 'closet' },
  { href: '/user/reports', icon: Flag, label: 'reports' },
  { href: '/user/profile', icon: User, label: 'profile' },
  { href: '/user/theme', icon: ColorsSwatch, label: 'theme' },
  { href: '/user/security', icon: Shield, label: 'security' },
  { href: '/user/oauth-clients', icon: Code, label: 'oauthClients' },
] as const

export function visibleUserNavItems(themes: boolean) {
  return themes ? userNavItems : userNavItems.filter(({ href }) => href !== '/user/theme')
}

export function UserNav({
  pluginItems,
  themes,
}: {
  /** 插件声明的导航项：标签已经翻译好，图标在服务端渲染 */
  pluginItems: readonly { href: string; label: string; icon: ReactElement }[]
  /** 显示主题页：启用的主题有两套以上 */
  themes: boolean
}) {
  const t = useTranslations('user.nav')
  const pathname = usePathname()
  return (
    <Nav label={t('label')}>
      {visibleUserNavItems(themes).map(({ href, icon: Icon, label }) => (
        <NavItem key={href} render={<NextLink href={href} />} icon={<Icon />} current={pathname === href}>
          {t(label)}
        </NavItem>
      ))}
      {pluginItems.map(({ href, icon, label }) => (
        <NavItem key={href} render={<NextLink href={href} />} icon={icon} current={pathname === href}>
          {label}
        </NavItem>
      ))}
    </Nav>
  )
}
