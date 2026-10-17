import { requestRoot } from '@nextskin/api'
import { getMessages, LOCALE_COOKIE, resolveLocale } from '@nextskin/i18n'
import { getRequestConfig } from 'next-intl/server'
import { cookies, headers } from 'next/headers'
import { getServer } from '../lib/server'

// 页面的语言（ADR-0019）：URL 不带语言前缀，按用户设置 → Cookie → Accept-Language → 站点默认的顺序取。
// 页面因此随 Cookie 和 Accept-Language 变化，不能被公共缓存
export default getRequestConfig(async () => {
  const [headerList, cookieStore, { core }] = await Promise.all([headers(), cookies(), getServer()])
  const settings = await core.settings.read(['site.locale', 'site.timeZone'])
  // getSessionUser 要客户端看到的站点地址，服务端组件里没有 Request，按请求头拼出来
  const user = await core.auth.getSessionUser(
    headerList,
    requestRoot(new Request('http://localhost/', { headers: headerList })),
  )
  const locale = resolveLocale({
    user: user?.locale,
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerList.get('accept-language'),
    siteDefault: settings['site.locale'],
  })
  // 服务端渲染和浏览器用同一个时区，避免水合不一致
  return { locale, messages: getMessages(locale), timeZone: settings['site.timeZone'] }
})
