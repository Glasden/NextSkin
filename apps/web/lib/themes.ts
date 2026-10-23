import { DIAMOND, type Core, type ThemeEntry } from '@nextskin/domain'
import { getLocale, getTranslations } from 'next-intl/server'
import { pluginName } from './plugins'

/**
 * 配色主题的名字和来源（ADR-0057）：内置的钻石青用 themes.builtin 下的文案，来源为 null；
 * 插件的主题名是插件自己的文案，来源是插件名
 */
export async function themeLabeler(core: Core) {
  const [locale, t] = await Promise.all([getLocale(), getTranslations('themes.builtin')])
  return (theme: Pick<ThemeEntry, 'pluginId' | 'label'>): { name: string; source: string | null } =>
    theme.pluginId === null
      ? { name: theme.label === DIAMOND ? t('diamond') : theme.label, source: null }
      : {
          name: core.plugins.translate(theme.pluginId, theme.label, locale),
          source: pluginName(core, theme.pluginId, locale),
        }
}

/** 主题页给每张小样输出的 CSS：每套限定在自己的 data-theme 上，钻石青也要（暗色页面里的亮色小样才是亮的） */
export function previewCss(themes: readonly Pick<ThemeEntry, 'css'>[]): string {
  return themes.map(({ css }) => css).join('')
}
