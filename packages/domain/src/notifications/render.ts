import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import { createTranslator, type Locale } from '@nextskin/i18n'
import type { Selectable } from 'kysely'
import { bindingName } from '../admin/notify.ts'
import type { PluginSystem } from '../plugins/system.ts'
import type { AccountChange, SystemNotificationParams } from './write.ts'

export interface NotificationView {
  id: number
  type: string
  title: string
  body: string | null
  format: 'text' | 'markdown'
  link: string | null
  readAt: IsoTimestamp | null
  createdAt: IsoTimestamp
}
export type NotificationRow = Selectable<CoreDatabase['notifications']> & { title: string | null; body: string | null }
export type NotificationPlugins = Pick<PluginSystem, 'get' | 'translate'>

export function renderNotification(
  row: NotificationRow,
  locale: Locale,
  plugins: NotificationPlugins,
): NotificationView {
  const t = createTranslator(locale)
  const view: NotificationView = {
    id: row.id,
    type: row.type,
    title: '',
    body: null,
    format: 'text',
    link: null,
    readAt: row.read_at,
    createdAt: row.created_at,
  }
  if (row.type === 'message') return { ...view, title: row.title!, body: row.body, format: 'markdown' }
  if (row.type === 'plugin') {
    const id = row.plugin_id!
    if (!plugins.get(id)) return { ...view, title: t('notifications.plugin.fallbackTitle', { id }), link: row.link }
    const params = JSON.parse(row.params ?? '{}') as Record<string, string | number>
    return {
      ...view,
      title: plugins.translate(id, row.title_key!, locale, params),
      body: row.body_key === null ? null : plugins.translate(id, row.body_key, locale, params),
      link: row.link,
    }
  }
  switch (row.type) {
    case 'update.available': {
      const params = JSON.parse(row.params!) as SystemNotificationParams['update.available']
      return {
        ...view,
        title: t('notifications.types.update.available.title', params),
        body: t('notifications.types.update.available.body', params),
        link: '/admin/updates',
      }
    }
    case 'report.resolved': {
      const params = JSON.parse(row.params!) as SystemNotificationParams['report.resolved']
      return {
        ...view,
        title: t('notifications.types.report.resolved.title', params),
        body: t('notifications.types.report.resolved.body', params),
        link: '/user/reports',
      }
    }
    case 'report.pending':
      return {
        ...view,
        title: t('notifications.types.report.pending.title'),
        body: t('notifications.types.report.pending.body'),
        link: '/admin/reports',
      }
    case 'texture.removed': {
      const params = JSON.parse(row.params!) as SystemNotificationParams['texture.removed']
      return {
        ...view,
        title: t('notifications.types.texture.removed.title', params),
        body: t('notifications.types.texture.removed.body', params),
        link: params.action === 'unpublished' ? `/skinlib/${params.tid}` : null,
      }
    }
    case 'account.changed': {
      const { changes } = JSON.parse(row.params!) as SystemNotificationParams['account.changed']
      function line(change: AccountChange): string {
        const key = 'notifications.types.account.changed.changes' as const
        if (change.kind === 'email') return t(`${key}.email`, { pending: String(change.pending) })
        if (change.kind === 'binding')
          return t(`${key}.binding`, {
            provider: bindingName(plugins, change.pluginId, change.providerId, locale),
          })
        return t(`${key}.${change.kind}`, change)
      }
      const link = changes.some((change) => change.kind.startsWith('player'))
        ? '/user/players'
        : changes.some((change) => change.kind.startsWith('oauthClient'))
          ? '/user/oauth-clients'
          : '/user/security'
      return {
        ...view,
        title: t('notifications.types.account.changed.title'),
        body: t('notifications.types.account.changed.body', { changes: changes.map(line).join('\n') }),
        link,
      }
    }
    default:
      throw new TypeError('未知的系统通知类型')
  }
}
