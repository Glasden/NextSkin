import type { PluginSummary } from '@nextskin/domain'
import { Badge } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'

/**
 * 插件的状态：已启用、未启用；表里启用了、这个实例还没切换过来的是“切换中”（每个实例 5 秒读一次，ADR-0033）。
 * 最近一次启用失败（迁移出错）时再跟一个“出错了”
 */
export async function PluginStatus({ plugin }: { plugin: Pick<PluginSummary, 'enabled' | 'running' | 'lastError'> }) {
  const t = await getTranslations('admin.plugins')
  const status = plugin.enabled === plugin.running ? (plugin.enabled ? 'enabled' : 'disabled') : 'switching'
  return (
    <span className="flex items-center gap-2">
      <Badge tone={status === 'enabled' ? 'success' : status === 'switching' ? 'warning' : 'neutral'}>
        {t(`status.${status}`)}
      </Badge>
      {plugin.lastError && <Badge tone="danger">{t('lastError')}</Badge>}
    </span>
  )
}
