import type { PluginHostStatus } from '@nextskin/domain'
import { Alert } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import { HostRestart } from './host-restart'

/** plugin host 在重启，或者连续崩溃后停止了重启：上传安装的插件这时都不可用（ADR-0033） */
export function isHostDown(status: PluginHostStatus): boolean {
  return status.state === 'restarting' || status.state === 'failed'
}

/**
 * plugin host 不在运行时的提示。停止重启之后给一个重启按钮：管理员先停用出问题的插件，再手动重启。
 * 正在运行、还没有安装插件时什么也不显示
 */
export async function HostAlert({ status }: { status: PluginHostStatus }) {
  const t = await getTranslations('admin.plugins.host')
  if (!isHostDown(status)) return null
  const reason = status.lastError && (
    <span className="font-mono text-xs break-all text-text-muted">{t('lastError', { error: status.lastError })}</span>
  )
  return status.state === 'failed' ? (
    <Alert tone="danger">
      <span className="flex flex-col items-start gap-3">
        <span>{t('failed')}</span>
        {reason}
        <HostRestart />
      </span>
    </Alert>
  ) : (
    <Alert tone="warning">
      <span className="flex flex-col gap-1">
        <span>{t('restarting')}</span>
        {reason}
      </span>
    </Alert>
  )
}
