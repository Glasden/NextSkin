import { Logo, ToastProvider } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { getServer } from '../../lib/server'

/**
 * 安装向导和维护页的外壳：全屏的单列流程，不套用户中心和后台的外壳（ADR-0031）。
 * 只有标志，没有导航：向导期间别的页面还不能用，维护期间别的页面都会转到这里
 */
export async function FullscreenShell({ children }: { readonly children: ReactNode }) {
  const [{ core }, common] = await Promise.all([getServer(), getTranslations('common')])
  const { 'site.name': siteName } = await core.settings.read(['site.name'])
  return (
    <ToastProvider label={common('notifications')} closeLabel={common('close')}>
      <div className="flex min-h-dvh flex-col">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex h-16 w-full max-w-4xl items-center px-4 sm:px-6">
            <Logo name={siteName} />
          </div>
        </header>
        <main className="flex-1 px-4 py-8 sm:px-6 sm:py-12">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">{children}</div>
        </main>
      </div>
    </ToastProvider>
  )
}
