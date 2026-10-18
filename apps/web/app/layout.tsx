import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { getServer } from '../lib/server'
import './globals.css'

// 站点描述同时是首页主标题下的一句话和 meta description；没写时用首页的默认介绍（ADR-0032）
export async function generateMetadata(): Promise<Metadata> {
  const [{ core }, t] = await Promise.all([getServer(), getTranslations('home')])
  const settings = await core.settings.read(['site.name', 'site.description', 'site.keywords'])
  const name = settings['site.name']
  const description = settings['site.description'].trim() || t('description')
  return {
    title: { default: name, template: `%s · ${name}` },
    description,
    ...(settings['site.keywords'].length ? { keywords: settings['site.keywords'] } : {}),
    // 聊天软件贴出站点链接时显示站点名和描述；不带图片
    openGraph: { type: 'website', siteName: name, title: name, description },
  }
}

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang={await getLocale()}>
      <body className="min-h-dvh bg-bg font-sans text-text">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  )
}
