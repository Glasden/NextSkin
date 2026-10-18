import { Badge, Link, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { pluginDescription, pluginName } from '../../../lib/plugins'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { PluginStatus } from './plugin-status'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.plugins')
  return { title: t('title') }
}

type Column = 'plugin' | 'version' | 'status' | 'deadLetters'

/**
 * 插件列表（ADR-0033）：随发行包分发的官方插件，状态、最近的错误和失败的任务数。
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
  const plugins = await core.plugins.admin.list({ uid: user.uid, ip: null })

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

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
                    {plugin.official && <Badge>{t('official')}</Badge>}
                  </span>
                  {description && <span className="text-xs text-pretty text-text-muted">{description}</span>}
                </span>
              ),
              version: <span className="font-mono text-xs">{plugin.version}</span>,
              status: <PluginStatus plugin={plugin} />,
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
