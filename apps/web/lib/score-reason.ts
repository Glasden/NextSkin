import { getLocale, getTranslations } from 'next-intl/server'
import { pluginName } from './plugins'
import { getServer } from './server'

/**
 * 积分流水的原因怎么显示。核心写的是 `score.reasons.*` 的键，翻译不了时原样显示；
 * 插件写的是插件自己的文案键（ADR-0041），按插件的文案翻译，插件卸载了或文案里没有这个键时显示"来自插件 X"
 */
export async function scoreReasonText() {
  const [{ core }, t, locale] = await Promise.all([getServer(), getTranslations('score'), getLocale()])
  return (entry: { reason: string; pluginId: string | null }): string => {
    if (entry.pluginId !== null) {
      if (core.plugins.hasMessage(entry.pluginId, entry.reason))
        return core.plugins.translate(entry.pluginId, entry.reason, locale)
      const known = core.plugins.get(entry.pluginId) !== undefined
      return t('fromPlugin', { name: known ? pluginName(core, entry.pluginId, locale) : entry.pluginId })
    }
    const key = `reasons.${entry.reason.replace(/^score\.reasons\./, '')}` as 'reasons.initial'
    return t.has(key) ? t(key) : entry.reason
  }
}
