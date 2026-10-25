import { hasAdminAccess } from '@nextskin/domain'
import { CspProvider, ValidationMessagesProvider } from '@nextskin/ui'
import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import { cookies, headers } from 'next/headers'
import { Suspense, type ReactNode } from 'react'
import { COLOR_MODE_COOKIE, colorModeScript, parseColorMode } from '../lib/color-mode'
import { NONCE_HEADER } from '../lib/csp'
import { getServer } from '../lib/server'
import { getSessionUser } from '../lib/session'
import { iconsMetadata, siteIconHash } from '../lib/site-icons'
import { ColorModeProvider } from './color-mode-menu'
import { CustomCss } from './custom-css'
import { CustomHead } from './custom-head'
import { HeadCodeGuard } from './head-code-guard'
import { NavigationEvent } from './navigation-event'
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

// data-mode 由 <head> 里的内联脚本在第一次绘制之前设上（lib/color-mode.ts）。服务端渲染的 <html> 上没有这个属性，
// 水合时和页面对不上，所以 <html> 不报水合不一致。
// 内联脚本要带 proxy.ts 生成的 nonce 才会执行（ADR-0053），Base UI 插的脚本和样式经 CspProvider 拿到它。
// 配色主题（ADR-0057）：data-theme 写在 <html> 上，不是钻石青时输出这一套的 CSS（样式不受 CSP 约束，不用 nonce）。
// 自定义代码（ADR-0063）：页头代码排在主题的样式后面，有管理权限的用户登录后不加载（别的标签页、同一个文档里身份变了，
// 整页重新加载：lib/session-change.ts、HeadCodeGuard），有页头代码的页面在客户端跳转时派发 nextskin:navigate；
// 自定义 CSS 放在 <body> 开头，后台不套用。
// 导入期间不查会话，用站点默认（同 i18n/request.ts），也不读自定义代码
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const [locale, cookieStore, headerList, { core, importer }, t] = await Promise.all([
    getLocale(),
    cookies(),
    headers(),
    getServer(),
    getTranslations('common'),
  ])
  const nonce = headerList.get(NONCE_HEADER) ?? undefined
  const user = importer.maintenance() ? null : await getSessionUser()
  const [theme, custom] = await Promise.all([
    core.themes.current(user?.uid ?? null),
    importer.maintenance() ? null : core.customCode.page(),
  ])
  const admin = !!user && hasAdminAccess(user.role)
  const head = custom && !admin ? custom.head : []
  return (
    <html lang={locale} data-theme={theme.id} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: colorModeScript }} />
        {/* 主题 id 和色值都校验过格式（packages/theme 的 themeCss），拼不出别的东西 */}
        {theme.css && <style dangerouslySetInnerHTML={{ __html: theme.css }} />}
        <CustomHead elements={head} nonce={nonce} />
      </head>
      <body className="min-h-dvh bg-bg font-sans text-text">
        {custom?.css && <CustomCss css={custom.css} />}
        <CspProvider nonce={nonce}>
          <NextIntlClientProvider>
            {/* 控件没填就提交时的提示跟随站点语言，不用浏览器给的消息（它跟随浏览器语言） */}
            <ValidationMessagesProvider
              messages={{
                required: t('validation.required'),
                format: t('validation.format'),
                tooShort: t('validation.tooShort'),
                range: t('validation.range'),
              }}
            >
              <ColorModeProvider value={parseColorMode(cookieStore.get(COLOR_MODE_COOKIE)?.value)}>
                {children}
              </ColorModeProvider>
            </ValidationMessagesProvider>
          </NextIntlClientProvider>
        </CspProvider>
        <HeadCodeGuard loaded={head.length > 0} admin={admin} />
        {head.length > 0 && (
          <Suspense fallback={null}>
            <NavigationEvent />
          </Suspense>
        )}
      </body>
    </html>
  )
}
