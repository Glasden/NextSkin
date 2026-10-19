import { getLocale, getTranslations } from 'next-intl/server'
import type { ExternalProvider } from '../app/(auth)/external-login-buttons'
import { pluginIcon } from './plugins'
import { getServer } from './server'

// 第三方登录（ADR-0034）在服务端组件里共用的几个函数

/** 登录页、注册页上的按钮：插件启用了、设置齐全的 login Provider，名称按插件的文案翻译 */
export async function externalProviders(): Promise<ExternalProvider[]> {
  const [{ core }, locale] = await Promise.all([getServer(), getLocale()])
  return (await core.externalLogin.providers()).map((entry) => ({
    pluginId: entry.pluginId,
    providerId: entry.providerId,
    name: core.plugins.translate(entry.pluginId, entry.label, locale),
    icon: pluginIcon(entry.icon, { 'aria-hidden': true }),
  }))
}

/** 回调跳回登录页、安全页时带的错误码。只认这些，地址栏里别的值一律当作"没能登录" */
const callbackErrors = [
  'external_login_not_found',
  'external_login_unavailable',
  'external_login_failed',
  'external_login_cancelled',
  'external_login_expired',
  'external_email_taken',
  'registration_disabled',
  'identity_bound_elsewhere',
  'already_bound',
] as const

/** 地址栏里的 `?error=` 对应的文案；没有这个参数时为 null */
export async function externalErrorMessage(value: string | string[] | undefined): Promise<string | null> {
  if (typeof value !== 'string') return null
  const t = await getTranslations('errors')
  const code = (callbackErrors as readonly string[]).includes(value)
    ? (value as (typeof callbackErrors)[number])
    : 'external_login_failed'
  return t(code)
}
