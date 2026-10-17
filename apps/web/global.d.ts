import type { Locale, Messages } from '@nextskin/i18n'

// 消息键和 ICU 参数按 packages/i18n 的源语言做类型检查（ADR-0019）
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale
    Messages: Messages
  }
}
