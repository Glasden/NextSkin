'use client'

import { Nav, NavItem } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { usePathname } from 'next/navigation'
import { Image } from 'pixelarticons/react/Image.js'
import { Upload } from 'pixelarticons/react/Upload.js'

/** 全站导航：宽屏在页头里横排，窄屏在页头打开的 Sheet 里竖排（placement 同 Nav）。上传页在皮肤库下面，但单独算一项 */
export function SiteNav({ placement = 'header' }: { placement?: 'header' | 'sidebar' }) {
  const t = useTranslations('site.nav')
  const pathname = usePathname()
  const uploading = pathname === '/skinlib/upload'
  return (
    <Nav label={t('label')} placement={placement}>
      <NavItem
        render={<NextLink href="/skinlib" />}
        icon={<Image />}
        current={!uploading && (pathname === '/skinlib' || pathname.startsWith('/skinlib/'))}
      >
        {t('skinlib')}
      </NavItem>
      <NavItem render={<NextLink href="/skinlib/upload" />} icon={<Upload />} current={uploading}>
        {t('upload')}
      </NavItem>
    </Nav>
  )
}
