import { getMessages, LOCALE_COOKIE, resolveLocale } from '@nextskin/i18n'
import { getRequestConfig } from 'next-intl/server'
import { cookies, headers } from 'next/headers'
import { getServer } from '../lib/server'
import { getSessionUser } from '../lib/session'

// 页面的语言（ADR-0019）：URL 不带语言前缀，按用户设置 → Cookie → Accept-Language → 站点默认的顺序取。
// 页面因此随 Cookie 和 Accept-Language 变化，不能被公共缓存
export default getRequestConfig(async () => {
  const [headerList, cookieStore, { core, importer }] = await Promise.all([headers(), cookies(), getServer()])
  // 导入期间（维护模式）不查会话：Better Auth 可能顺手给会话续期，而写锁在导入的事务手里（ADR-0031）
  const user = importer.maintenance() ? null : await getSessionUser()
  const settings = await core.settings.read(['site.locale', 'site.timeZone'])
  const locale = resolveLocale({
    user: user?.locale,
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerList.get('accept-language'),
    siteDefault: settings['site.locale'],
  })
  // 服务端渲染和浏览器用同一个时区，避免水合不一致
  return { locale, messages: getMessages(locale), timeZone: settings['site.timeZone'] }
})
