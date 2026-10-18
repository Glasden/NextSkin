import { createTranslator } from 'use-intl/core'

/** 插件的文案：`locales/<语言>.json` 的内容，按语言放。格式同核心，ICU MessageFormat（ADR-0019） */
export type PluginMessages = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/**
 * 取插件文案：先找请求的语言，再找后备语言，都没有就原样返回键名。
 * 插件的文案缺了不该让调用失败，界面上显示键名，作者一眼就能看出来。
 */
export function translatePlugin(
  messages: PluginMessages,
  key: string,
  options: { locale: string; fallbackLocale: string; params?: Readonly<Record<string, string | number>> },
): string {
  for (const locale of [options.locale, options.fallbackLocale]) {
    const catalog = messages[locale]
    if (!catalog || typeof lookup(catalog, key) !== 'string') continue
    let failed = false
    const t = translator({
      locale,
      messages: catalog,
      onError: () => {
        failed = true
      },
    })
    const text = t(key, options.params ? { ...options.params } : undefined)
    if (!failed) return text
  }
  return key
}

/**
 * 插件的文案不是核心的类型化文案：键和语言都是运行时的字符串。网页还会把 use-intl 的 Locale
 * 收窄成核心支持的语言（apps/web/global.d.ts），插件的语言不受它限制
 */
const translator = createTranslator as unknown as (options: {
  locale: string
  messages: Readonly<Record<string, unknown>>
  onError: () => void
}) => (key: string, values?: Record<string, string | number>) => string

function lookup(catalog: Readonly<Record<string, unknown>>, key: string): unknown {
  let value: unknown = catalog
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}
