import { Logo, ToastProvider } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { getServer } from '../../lib/server'
import { siteImageUrl } from '../../lib/site-images'
import { ColorModeMenu } from '../color-mode-menu'

/**
 * 安装向导和维护页的外壳：全屏的单列流程，不套用户中心和后台的外壳（ADR-0031）。
 * 只有标志和亮暗模式，没有导航：向导期间别的页面还不能用，维护期间别的页面都会转到这里
 */
export async function FullscreenShell({ children }: { readonly children: ReactNode }) {
  const [{ core }, common] = await Promise.all([getServer(), getTranslations('common')])
  // 安装之前没有设置，标志是内置的图形；导入不动站点标志（ADR-0042），维护页照旧显示它
  const { 'site.name': siteName, 'site.logo': logo } = await core.settings.read(['site.name', 'site.logo'])
  return (
    <ToastProvider label={common('notifications')} closeLabel={common('close')}>
      <div className="flex min-h-dvh flex-col">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex h-16 w-full max-w-4xl items-center justify-between gap-4 px-4 sm:px-6">
            <Logo name={siteName} image={logo ? siteImageUrl(logo) : undefined} />
            <ColorModeMenu />
          </div>
        </header>
        <main className="flex-1 px-4 py-8 sm:px-6 sm:py-12">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">{children}</div>
        </main>
      </div>
    </ToastProvider>
  )
}
