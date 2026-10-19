import { Alert, Badge, Link, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { pluginDescription, pluginName } from '../../../lib/plugins'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { HostAlert, isHostDown } from './host-alert'
import { PluginStatus } from './plugin-status'
import { PluginUpload } from './plugin-upload'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.plugins')
  return { title: t('title') }
}

type Column = 'plugin' | 'version' | 'status' | 'deadLetters'

/**
 * 插件列表（ADR-0033）：随发行包分发的官方插件和上传安装的插件，状态、最近的错误和失败的任务数；上传插件的入口。
 * 只有超级管理员能进来（plugins.manage）：启用插件等于在服务器上运行它的代码
 */
export default async function AdminPluginsPage() {
  const user = await requireAdmin('/admin/plugins', 'plugins.manage')
  const [{ core }, t, format, locale] = await Promise.all([
    getServer(),
    getTranslations('admin.plugins'),
    getFormatter(),
    getLocale(),
  ])
  const actor = { uid: user.uid, ip: null }
  const [plugins, host] = await Promise.all([core.plugins.admin.list(actor), core.plugins.admin.hostStatus(actor)])
  const installed = plugins.some((plugin) => !plugin.official)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
          <p className="max-w-3xl text-sm text-pretty text-text-muted">{t('description')}</p>
        </div>
        {host.enabled && <PluginUpload networkRestricted={host.networkRestricted} />}
      </header>

      <HostAlert status={host} />
      {installed && !host.networkRestricted && <Alert tone="warning">{t('host.networkUnrestricted')}</Alert>}

      <Table<Column>
        label={t('tableLabel')}
        empty={t('empty')}
        columns={[
          { key: 'plugin', header: t('columns.plugin') },
          { key: 'version', header: t('columns.version'), shrink: true },
          { key: 'status', header: t('columns.status'), shrink: true },
          { key: 'deadLetters', header: t('columns.deadLetters'), align: 'end', shrink: true },
        ]}
        rows={plugins.map((plugin) => {
          const name = pluginName(core, plugin.id, locale)
          const description = pluginDescription(core, plugin.id, locale)
          return {
            key: plugin.id,
            cells: {
              plugin: (
                <span className="flex min-w-64 flex-col gap-0.5 py-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link render={<NextLink href={`/admin/plugins/${plugin.id}`} />}>{name}</Link>
                    <code className="font-mono text-xs text-text-muted">{plugin.id}</code>
                    <Badge>{t(plugin.official ? 'official' : 'installed')}</Badge>
                  </span>
                  {description && <span className="text-xs text-pretty text-text-muted">{description}</span>}
                </span>
              ),
              version: <span className="font-mono text-xs">{plugin.version}</span>,
              status: <PluginStatus plugin={plugin} hostDown={!plugin.official && isHostDown(host)} />,
              deadLetters: plugin.deadLetters ? (
                <span className="text-danger">{format.number(plugin.deadLetters)}</span>
              ) : (
                <span className="text-text-muted">0</span>
              ),
            },
          }
        })}
      />
    </div>
  )
}
