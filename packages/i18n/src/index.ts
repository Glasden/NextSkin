// 界面文案与语言解析（ADR-0019）。网页通过 next-intl 使用同一份消息；领域层（邮件、站内通知、接口错误）
// 用这里的 createTranslator，不依赖 React 和 Next。
import { createTranslator as createCoreTranslator } from 'use-intl/core'
import en from '../messages/en.json' with { type: 'json' }
import zhCN from '../messages/zh-CN.json' with { type: 'json' }

/** 完整维护的语言。zh-CN 是源语言：文案先写中文（DESIGN.md §1），每次加文案都要同时写英文 */
export const locales = ['zh-CN', 'en'] as const
export type Locale = (typeof locales)[number]
export const sourceLocale: Locale = 'zh-CN'

/** 未登录时，语言切换器把选择写在这个 Cookie 里 */
export const LOCALE_COOKIE = 'nextskin-locale'

/** 消息的类型以源语言为准：键名拼错、ICU 参数缺失都是编译错误 */
export type Messages = typeof zhCN

const catalogs: Record<Locale, Messages> = { 'zh-CN': zhCN, en }

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value)
}

/**
 * 把语言标签对应到受支持的语言，对应不上返回 null。
 * 中文的各种变体（zh、zh-TW、zh-Hant……）对应 zh-CN，英文的变体对应 en，与缺键时的回退规则一致
 */
export function matchLocale(tag: string): Locale | null {
  const normalized = tag.trim().toLowerCase()
  const exact = locales.find((locale) => locale.toLowerCase() === normalized)
  if (exact) return exact
  const language = normalized.split('-')[0]
  if (language === 'zh') return 'zh-CN'
  if (language === 'en') return 'en'
  return null
}

/** 按 q 值从高到低，取 Accept-Language 里第一个能对应上的语言 */
export function matchAcceptLanguage(header: string): Locale | null {
  const ranges = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params.map((param) => /^\s*q=([0-9.]+)\s*$/i.exec(param)?.[1]).find((value) => value !== undefined)
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index }
    })
    .filter((range) => range.tag && range.tag !== '*' && range.q > 0)
    // q 相同时保持原来的顺序
    .sort((a, b) => b.q - a.q || a.index - b.index)
  for (const range of ranges) {
    const locale = matchLocale(range.tag)
    if (locale) return locale
  }
  return null
}

export interface LocaleSources {
  /** 登录用户的 users.locale */
  user?: string | null
  /** LOCALE_COOKIE 的值 */
  cookie?: string | null
  acceptLanguage?: string | null
  /** 站点默认语言（设置项 site.locale） */
  siteDefault: Locale
}

/** 按 ADR-0019 的顺序取语言：用户设置 → Cookie → Accept-Language → 站点默认 */
export function resolveLocale(sources: LocaleSources): Locale {
  return (
    (sources.user ? matchLocale(sources.user) : null) ??
    (sources.cookie ? matchLocale(sources.cookie) : null) ??
    (sources.acceptLanguage ? matchAcceptLanguage(sources.acceptLanguage) : null) ??
    sources.siteDefault
  )
}

/** 一种语言的全部消息。现在两种语言都是完整的（测试守着）；以后加入社区翻译时，在这里按回退规则补齐缺的键 */
export function getMessages(locale: Locale): Messages {
  return catalogs[locale]
}

/** 不依赖 React 的翻译函数，用法与 next-intl 的 useTranslations 相同 */
export function createTranslator(locale: Locale) {
  return createCoreTranslator({ locale, messages: getMessages(locale) })
}
