import type { PluginSummary } from '@nextskin/domain'
import { Badge } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'

/**
 * 插件的状态：已启用、未启用；表里启用了、这个实例还没切换过来的是“切换中”（每个实例 5 秒读一次，ADR-0033）。
 * 上传安装的插件启用着、plugin host 却在重启或者停了，或者本实例取不到它的包，是“不可用”。
 * 取不到包时再跟一个“取不到插件包”，最近一次启用失败（迁移出错）时再跟一个“出错了”
 */
export async function PluginStatus({
  plugin,
  hostDown = false,
}: {
  plugin: Pick<PluginSummary, 'enabled' | 'running' | 'lastError' | 'packageMissing'>
  /** plugin host 在重启或者已经停止重启；只对上传安装的插件传 true */
  hostDown?: boolean
}) {
  const t = await getTranslations('admin.plugins')
  const status =
    plugin.enabled === plugin.running
      ? plugin.enabled
        ? 'enabled'
        : 'disabled'
      : plugin.enabled && (hostDown || plugin.packageMissing)
        ? 'unavailable'
        : 'switching'
  const tone = { enabled: 'success', disabled: 'neutral', switching: 'warning', unavailable: 'danger' } as const
  return (
    <span className="flex items-center gap-2">
      <Badge tone={tone[status]}>{t(`status.${status}`)}</Badge>
      {plugin.packageMissing && <Badge tone="danger">{t('packageMissing')}</Badge>}
      {plugin.lastError && <Badge tone="danger">{t('lastError')}</Badge>}
    </span>
  )
}
