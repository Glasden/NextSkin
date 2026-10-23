'use client'

import { IconButton, Logo, Sheet } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu } from 'pixelarticons/react/Menu.js'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { SiteNav } from './site-nav'

/** 用户中心、后台的分区导航：标题是该区域的名称，nav 是布局渲染好的侧栏导航 */
export interface SectionNav {
  label: string
  nav: ReactNode
}

/**
 * 窄屏页头最左边的“打开导航”：从左边滑出全站导航，在用户中心和后台下面还有该区域的分区（DESIGN.md §10）。
 * 点了里面的链接马上关上，不等新页面渲染出来；换了页面（包括浏览器的前进后退）也算关上
 */
export function NavSheet({ siteName, logo, section }: { siteName: string; logo?: string; section?: SectionNav }) {
  const t = useTranslations('site.navSheet')
  const pathname = usePathname()
  // 记的是在哪个地址打开的：地址一变就是关着的，不用在 effect 里改状态
  const [openOn, setOpenOn] = useState<string | null>(null)
  const close = () => setOpenOn(null)
  const closeOnLink = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('a')) close()
  }
  return (
    <Sheet
      side="start"
      open={openOn === pathname}
      onOpenChange={(open) => setOpenOn(open ? pathname : null)}
      trigger={
        <IconButton label={t('open')}>
          <Menu />
        </IconButton>
      }
      title={<Logo name={siteName} image={logo} size="sm" render={<NextLink href="/" onClick={close} />} />}
      closeLabel={t('close')}
    >
      <div className="flex flex-col gap-4 p-4" onClick={closeOnLink}>
        <SiteNav placement="sidebar" />
        {section && (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="px-3 font-pixel text-pixel-1 text-text-muted">{section.label}</h3>
            {section.nav}
          </div>
        )}
      </div>
    </Sheet>
  )
}
