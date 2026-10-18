import { locales, type Locale } from '@nextskin/i18n'

/** 语言的自称：在哪种界面语言下都写成这种语言自己的文字，用户才认得出自己要的那一项 */
const names = { 'zh-CN': '简体中文', en: 'English' } as const satisfies Record<Locale, string>

export const localeOptions = locales.map((value) => ({ value, label: names[value] }))
