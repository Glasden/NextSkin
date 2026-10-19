import {
  coreSettingsRegistry,
  settingControl,
  settingJsonSchema,
  type AuditEntry,
  type CoreSettingKey,
} from '@nextskin/domain'
import { Link, Table } from '@nextskin/ui'
import { getFormatter, getLocale, getMessages, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { pluginName } from '../../lib/plugins'
import { getServer } from '../../lib/server'
import { auditHref } from './params'
import { formatSettingValue, settingsHref, settingText } from './settings/setting-text'

type Column = 'time' | 'actor' | 'action' | 'subject' | 'details' | 'ip'

// 审计记录的动作名带点号（`report.resolve`），next-intl 的键不能带点号，换成驼峰的键
const actionKeys = {
  'report.resolve': 'reportResolve',
  'texture.delete': 'textureDelete',
  'user.setRole': 'userSetRole',
  'setting.update': 'settingUpdate',
  'site.setup': 'siteSetup',
  'plugin.enable': 'pluginEnable',
  'plugin.disable': 'pluginDisable',
  'plugin.settings': 'pluginSettings',
  'plugin.deadLetter': 'pluginDeadLetter',
  'plugin.install': 'pluginInstall',
  'plugin.upgrade': 'pluginUpgrade',
  'plugin.uninstall': 'pluginUninstall',
  'plugin.restartHost': 'pluginRestartHost',
} as const

// 处理举报的 details.action 可能是接口的动作，也可能是 SDK 的处理方式，都映射到同一份文案
const resolutionKeys = {
  dismiss: 'dismissed',
  dismissed: 'dismissed',
  deleteTexture: 'textureDeleted',
  textureDeleted: 'textureDeleted',
  banUploader: 'uploaderBanned',
  uploaderBanned: 'uploaderBanned',
} as const

const roles = ['banned', 'user', 'admin', 'superadmin'] as const
const textureTypes = ['steve', 'alex', 'cape'] as const

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
}

function settingKey(value: unknown): CoreSettingKey | null {
  return typeof value === 'string' && Object.hasOwn(coreSettingsRegistry, value) ? (value as CoreSettingKey) : null
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null
}

/**
 * 审计记录的表格，概览页和审计日志页共用（ADR-0027）。操作者的名字链接到只看他的记录；
 * 对象还在的，链接到它；已经删除的，显示 details 里的快照
 */
export async function AuditTable({
  entries,
  label,
  empty,
}: {
  entries: readonly AuditEntry[]
  label: string
  empty: string
}) {
  const [t, admin, reports, types, settings, messages, format, { core }, locale] = await Promise.all([
    getTranslations('admin.audit'),
    getTranslations('admin'),
    getTranslations('admin.reports'),
    getTranslations('skinlib.types'),
    getTranslations('admin.settings'),
    getMessages(),
    getFormatter(),
    getServer(),
    getLocale(),
  ])
  const settingFields = messages.admin.settings.fields
  const columns = [
    { key: 'time', header: t('columns.time'), shrink: true },
    { key: 'actor', header: t('columns.actor') },
    { key: 'action', header: t('columns.action'), shrink: true },
    { key: 'subject', header: t('columns.subject') },
    { key: 'details', header: t('columns.details') },
    { key: 'ip', header: t('columns.ip'), shrink: true },
  ] as const
  const role = (value: unknown) => {
    const known = oneOf(roles, value)
    return known ? admin(`roles.${known}`) : (text(value) ?? '')
  }

  function actor(entry: AuditEntry) {
    if (entry.actor.type === 'system') return <span className="text-text-muted">{t('actorSystem')}</span>
    if (entry.actor.type === 'plugin') return t('actorPlugin', { id: entry.actor.pluginId })
    const { uid, nickname } = entry.actor
    return (
      <Link render={<NextLink href={auditHref({ subject: null, actor: uid, page: 1 })} />}>
        {nickname ?? t('actorGone', { uid })}
      </Link>
    )
  }

  function subject(entry: AuditEntry) {
    const { type, id, exists } = entry.subject
    // 插件也没有整数 id（记作 0），插件 id 在 details 里；插件还在就链接到它的页面（ADR-0033）
    if (type === 'plugin') {
      if (entry.action === 'plugin.restartHost') return t('subjects.pluginHost')
      const plugin = text(entry.details.plugin)
      if (!plugin) return t('subjects.other', { type, id })
      const label = t('subjects.plugin', { name: core.plugins.get(plugin) ? pluginName(core, plugin, locale) : plugin })
      return core.plugins.get(plugin) ? (
        <Link render={<NextLink href={`/admin/plugins/${plugin}`} />}>{label}</Link>
      ) : (
        label
      )
    }
    // 设置项没有整数 id（记作 0），对象就是 details 里的键，链接到它所在的分区（ADR-0028）
    if (type === 'setting') {
      const key = settingKey(entry.details.key)
      const section = key ? coreSettingsRegistry[key].section : null
      const name = key ? settingText(settingFields, key).label : (text(entry.details.key) ?? t('subjects.setting'))
      return section ? <Link render={<NextLink href={settingsHref(section)} />}>{name}</Link> : name
    }
    const label =
      type === 'user' || type === 'texture' || type === 'report'
        ? t(`subjects.${type}`, { id })
        : t('subjects.other', { type, id })
    const snapshot = text(entry.details.name) ?? text(entry.details.nickname)
    const href = !exists
      ? null
      : type === 'user'
        ? `/admin/users?q=${id}`
        : type === 'texture'
          ? `/skinlib/${id}`
          : null
    return (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        {href ? (
          <Link render={<NextLink href={href} />}>{label}</Link>
        ) : (
          <span className="whitespace-nowrap">{label}</span>
        )}
        {snapshot && <span className="min-w-0 truncate text-text-muted">{snapshot}</span>}
      </span>
    )
  }

  /** 机密项不记值，只写“已更换”；长文只记长度；其余的写“旧值 → 新值” */
  function settingChange(details: AuditEntry['details']): string {
    const words = {
      checked: settings('checked'),
      unchecked: settings('unchecked'),
      empty: t('details.settingUpdate.empty'),
      number: (value: number) => format.number(value),
    }
    if (details.secret === true)
      return details.generated === true ? t('details.settingUpdate.generated') : t('details.settingUpdate.secret')
    const unreadable = details.unreadable === true
    if ('toLength' in details)
      return unreadable
        ? t('details.settingUpdate.value', {
            from: t('details.settingUpdate.unreadable'),
            to: format.number(count(details.toLength)),
          })
        : t('details.settingUpdate.length', { from: count(details.fromLength), to: count(details.toLength) })
    const key = settingKey(details.key)
    const control = key ? settingControl(settingJsonSchema(key)) : null
    const field = key ? settingText(settingFields, key) : { label: '' }
    return t('details.settingUpdate.value', {
      from: unreadable
        ? t('details.settingUpdate.unreadable')
        : formatSettingValue(details.from, control, field, words),
      to: formatSettingValue(details.to, control, field, words),
    })
  }

  /** 插件的设置项：标签取插件的文案，值按 JSON 原样写；机密项只写“已更换” */
  function pluginSettingChange(details: AuditEntry['details']): string {
    const plugin = text(details.plugin)
    const key = text(details.key) ?? ''
    const labelKey = `settings.${key}.label`
    const translated = plugin ? core.plugins.translate(plugin, labelKey, locale) : labelKey
    const value = (raw: unknown) =>
      typeof raw === 'string'
        ? raw === ''
          ? t('details.settingUpdate.empty')
          : raw
        : raw === null || raw === undefined
          ? t('details.settingUpdate.empty')
          : (JSON.stringify(raw) ?? '')
    return t('details.pluginSetting', {
      label: translated === labelKey ? key : translated,
      change:
        details.secret === true
          ? t('details.settingUpdate.secret')
          : t('details.settingUpdate.value', { from: value(details.from), to: value(details.to) }),
    })
  }

  function details(entry: AuditEntry) {
    const via =
      typeof entry.details.reportId === 'number' ? t('details.viaReport', { id: entry.details.reportId }) : null
    let summary: string | null = null
    if (entry.action === 'report.resolve') {
      const resolution = oneOf(Object.keys(resolutionKeys) as (keyof typeof resolutionKeys)[], entry.details.action)
      summary = t('details.reportResolve', {
        action: resolution ? reports(`resolutions.${resolutionKeys[resolution]}`) : (text(entry.details.action) ?? ''),
        refunded: count(entry.details.refunded),
        rewarded: count(entry.details.rewarded),
      })
    } else if (entry.action === 'texture.delete') {
      const type = oneOf(textureTypes, entry.details.type)
      summary = t('details.textureDelete', {
        name: text(entry.details.name) ?? '',
        type: type ? types(type) : (text(entry.details.type) ?? ''),
      })
    } else if (entry.action === 'user.setRole') {
      summary = t('details.userSetRole', { from: role(entry.details.from), to: role(entry.details.to) })
    } else if (entry.action === 'setting.update') {
      summary = settingChange(entry.details)
    } else if (
      entry.action === 'plugin.enable' ||
      entry.action === 'plugin.disable' ||
      entry.action === 'plugin.install' ||
      entry.action === 'plugin.uninstall'
    ) {
      summary = t('details.pluginVersion', { version: text(entry.details.version) ?? '' })
    } else if (entry.action === 'plugin.upgrade') {
      summary = t('details.pluginUpgrade', {
        from: text(entry.details.from) ?? '',
        to: text(entry.details.version) ?? '',
      })
    } else if (entry.action === 'plugin.settings') {
      summary = pluginSettingChange(entry.details)
    } else if (entry.action === 'plugin.deadLetter') {
      summary = t('details.pluginDeadLetter', {
        action: entry.details.action === 'retry' ? 'retry' : 'delete',
        job: count(entry.details.job),
      })
    }
    return (
      <span className="flex flex-col">
        {summary && <span>{summary}</span>}
        {via && <span className="text-xs text-text-muted">{via}</span>}
      </span>
    )
  }

  return (
    <Table<Column>
      label={label}
      empty={empty}
      columns={columns}
      rows={entries.map((entry) => ({
        key: entry.id,
        cells: {
          time: format.dateTime(new Date(entry.createdAt), { dateStyle: 'short', timeStyle: 'short' }),
          actor: actor(entry),
          action:
            entry.action in actionKeys
              ? t(`actions.${actionKeys[entry.action as keyof typeof actionKeys]}`)
              : entry.action,
          subject: subject(entry),
          details: details(entry),
          ip: entry.ip ? (
            <span className="font-mono text-xs">{entry.ip}</span>
          ) : (
            <span className="text-text-muted">—</span>
          ),
        },
      }))}
    />
  )
}
