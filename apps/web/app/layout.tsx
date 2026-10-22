import { CspProvider } from '@nextskin/ui'
import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import { cookies, headers } from 'next/headers'
import type { ReactNode } from 'react'
import { COLOR_MODE_COOKIE, colorModeScript, parseColorMode } from '../lib/color-mode'
import { NONCE_HEADER } from '../lib/csp'
import { getServer } from '../lib/server'
import { iconsMetadata, siteIconHash } from '../lib/site-icons'
import { ColorModeProvider } from './color-mode-menu'
import './globals.css'

// 每一页都读站点设置和 Cookie，没有能预渲染的页面。不声明的话，构建时 Next 会逐页试着预渲染，
// 先调用 getServer() 的页面会在构建期间打开核心
export const dynamic = 'force-dynamic'

// 站点描述同时是首页主标题下的一句话和 meta description；没写时用首页的默认介绍（ADR-0032）。
// 图标总是写在这里，不用 Next 的文件约定：那样的 favicon.ico 总排在最前面，换不掉（ADR-0042）
export async function generateMetadata(): Promise<Metadata> {
  const [{ core }, t] = await Promise.all([getServer(), getTranslations('home')])
  const settings = await core.settings.read([
    'site.name',
    'site.description',
    'site.keywords',
    'site.logo',
    'site.favicon',
  ])
  const name = settings['site.name']
  const description = settings['site.description'].trim() || t('description')
  return {
    title: { default: name, template: `%s · ${name}` },
    description,
    ...(settings['site.keywords'].length ? { keywords: settings['site.keywords'] } : {}),
    icons: iconsMetadata(siteIconHash(settings)),
    // 聊天软件贴出站点链接时显示站点名和描述；不带图片
    openGraph: { type: 'website', siteName: name, title: name, description },
  }
}

// data-theme 由 <head> 里的内联脚本在第一次绘制之前设上（lib/color-mode.ts）。服务端渲染的 <html> 上没有这个属性，
// 水合时和页面对不上，所以 <html> 不报水合不一致。
// 内联脚本要带 proxy.ts 生成的 nonce 才会执行（ADR-0053），Base UI 插的脚本和样式经 CspProvider 拿到它
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const [locale, cookieStore, headerList] = await Promise.all([getLocale(), cookies(), headers()])
  const nonce = headerList.get(NONCE_HEADER) ?? undefined
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: colorModeScript }} />
      </head>
      <body className="min-h-dvh bg-bg font-sans text-text">
        <CspProvider nonce={nonce}>
          <NextIntlClientProvider>
            <ColorModeProvider value={parseColorMode(cookieStore.get(COLOR_MODE_COOKIE)?.value)}>
              {children}
            </ColorModeProvider>
          </NextIntlClientProvider>
        </CspProvider>
      </body>
    </html>
  )
}
