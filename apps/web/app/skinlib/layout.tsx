import { ToastProvider } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { SiteFooter } from '../site-footer'
import { SiteHeader } from '../site-header'

/** 皮肤库、材质详情和上传页的外壳：全站页头、正文和页脚。不要求登录，写操作由接口检查（ADR-0025） */
export default async function SkinlibLayout({ children }: { readonly children: ReactNode }) {
  const common = await getTranslations('common')
  return (
    <ToastProvider label={common('notifications')} closeLabel={common('close')}>
      <div className="flex min-h-dvh flex-col">
        <SiteHeader />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-8">{children}</main>
        <SiteFooter />
      </div>
    </ToastProvider>
  )
}
